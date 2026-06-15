// sync.js — Planning Center → Firestore sync script
// Run manually: node functions/sync.js
// Or deploy as a Firebase Cloud Function (scheduled daily)
//
// Required env vars:
//   PCO_APP_ID     — your Planning Center Application ID
//   PCO_SECRET     — your Planning Center Personal Access Token secret
//   GOOGLE_APPLICATION_CREDENTIALS — path to Firebase service account JSON
//   ANTHROPIC_API_KEY — for RAP note parsing

import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// ── CONFIG ──────────────────────────────────────────────
const PCO_APP_ID = process.env.PCO_APP_ID;
const PCO_SECRET = process.env.PCO_SECRET;
const PCO_BASE   = "https://api.planningcenteronline.com/groups/v2";
const PCO_AUTH   = "Basic " + Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");
const DAYS_BEFORE_FLAG = 21;

// ── FIREBASE ─────────────────────────────────────────────
import { readFileSync } from "fs";
import { resolve } from "path";

const serviceAccount = JSON.parse(readFileSync(resolve("./service-account.json"), "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── ANTHROPIC ─────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── PCO HELPERS ───────────────────────────────────────────
async function pcoGet(path) {
  const res = await fetch(`${PCO_BASE}${path}`, { headers: { Authorization: PCO_AUTH } });
  if (!res.ok) throw new Error(`PCO API error ${res.status}: ${path}`);
  return res.json();
}

async function pcoGetAll(path) {
  let results = [], offset = 0, per_page = 100;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await pcoGet(`${path}${sep}per_page=${per_page}&offset=${offset}`);
    results = results.concat(data.data || []);
    if (!data.meta?.next?.offset) break;
    offset = data.meta.next.offset;
  }
  return results;
}

// ── RAP NOTE PARSER ───────────────────────────────────────
async function parseRAPNote(rawNote) {
  if (!rawNote || rawNote.trim().length < 10) return { rundown: null, additions: null, prayer: null, raw: rawNote };

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Extract the RAP report sections from this connection group note. Return ONLY valid JSON with keys "rundown", "additions", "prayer". If a section is missing return null for that key. Do not include any other text.

Note:
${rawNote}

JSON:`
      }]
    });

    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text);
    return { ...parsed, raw: rawNote };
  } catch (e) {
    console.warn("RAP parse failed, storing raw:", e.message);
    return { rundown: null, additions: null, prayer: null, raw: rawNote };
  }
}

// ── MAIN SYNC ─────────────────────────────────────────────
async function sync() {
  console.log("Starting Planning Center sync…");
  const startTime = Date.now();

  // 1. Fetch all groups
  console.log("Fetching groups…");
  const groupsRaw = await pcoGetAll("/groups");
  console.log(`Found ${groupsRaw.length} groups`);

  const now = new Date();
  const cutoff = new Date(now - DAYS_BEFORE_FLAG * 24 * 60 * 60 * 1000);

  const batch = db.batch();
  const groupSummaries = [];

  for (const g of groupsRaw) {
    const gid = g.id;
    const attrs = g.attributes;
    const groupName = attrs.name || "";
    const shortName = groupName.replace(/^TSC CG:\s*/i, "");

    // 2. Fetch events for this group
    const eventsRaw = await pcoGetAll(`/groups/${gid}/events`);
    eventsRaw.sort((a, b) => new Date(a.attributes.starts_at) - new Date(b.attributes.starts_at));

    // 3. Fetch members
    const membersRaw = await pcoGetAll(`/groups/${gid}/memberships`);
    const memberCount = membersRaw.length;

    // 4. Fetch leaders / tags
    const tagsRaw = await pcoGetAll(`/groups/${gid}/tags`);
    const leaderNames = membersRaw
      .filter(m => m.attributes.role === "leader")
      .map(m => m.attributes.first_name + " " + m.attributes.last_name)
      .join(", ");

    // 5. Process events → attendance + notes
    const eventDocs = [];
    const attendanceHistory = [];
    let lastEventDate = null;

    for (const ev of eventsRaw) {
      const evAttrs = ev.attributes;
      const evDate = new Date(evAttrs.starts_at);
      const attendanceRaw = await pcoGetAll(`/groups/${gid}/events/${ev.id}/attendances`);
      const attended = attendanceRaw.filter(a => a.attributes.attended).length;
      const visitors = attendanceRaw.filter(a => a.attributes.attended && a.attributes.role === "visitor").length;

      const noteRaw = evAttrs.note || "";
      const parsedNote = noteRaw ? await parseRAPNote(noteRaw) : { rundown: null, additions: null, prayer: null, raw: "" };

      const evDoc = {
        event_id: ev.id,
        date: Timestamp.fromDate(evDate),
        date_str: evDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        attended_count: attended,
        visitor_count: visitors,
        total_count: attended,
        note: parsedNote
      };

      eventDocs.push(evDoc);
      attendanceHistory.push(attended);
      if (!lastEventDate || evDate > lastEventDate) lastEventDate = evDate;
    }

    // 6. Compute stats
    const last8 = attendanceHistory.slice(-8);
    const avgAttendance = attendanceHistory.length
      ? Math.round((attendanceHistory.reduce((s, v) => s + v, 0) / attendanceHistory.length) * 10) / 10
      : 0;
    const attendRate = memberCount ? Math.round((avgAttendance / memberCount) * 100) : 0;
    const flagged = lastEventDate ? lastEventDate < cutoff : true;
    const lastReportStr = lastEventDate
      ? lastEventDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "Never";

    // 7. Write group doc
    const groupDoc = {
      short_name: shortName,
      full_name: groupName,
      leaders: leaderNames,
      members_count: memberCount,
      total_meetings: eventsRaw.length,
      avg_attendance: avgAttendance,
      attend_rate: attendRate,
      sparkline: last8,
      flagged,
      last_report: lastReportStr,
      last_report_date: lastEventDate ? Timestamp.fromDate(lastEventDate) : null,
      events: eventDocs,
      updated_at: Timestamp.now()
    };

    batch.set(db.collection("groups").doc(gid), groupDoc, { merge: true });
    groupSummaries.push({ id: gid, short_name: shortName });
    console.log(`  ✓ ${shortName} (${eventsRaw.length} events, last: ${lastReportStr})`);
  }

  // 8. Write sync metadata
  batch.set(db.collection("meta").doc("sync"), {
    lastSync: Timestamp.now(),
    groupCount: groupsRaw.length
  });

  await batch.commit();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nSync complete in ${elapsed}s — ${groupsRaw.length} groups written to Firestore.`);
}

sync().catch(err => { console.error("Sync failed:", err); process.exit(1); });
