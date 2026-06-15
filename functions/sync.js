import "dotenv/config";
import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { resolve } from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PCO_APP_ID = process.env.PCO_APP_ID;
const PCO_SECRET = process.env.PCO_SECRET;
const PCO_BASE   = "https://api.planningcenteronline.com/groups/v2";
const PCO_AUTH   = "Basic " + Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");
const DAYS_BEFORE_FLAG = 21;

// Only sync groups with this prefix
const GROUP_PREFIX = "TSC CG:";

const serviceAccount = JSON.parse(readFileSync(resolve("./service-account.json"), "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function pcoGet(path) {
  const res = await fetch(`${PCO_BASE}${path}`, { headers: { Authorization: PCO_AUTH } });
  if (!res.ok) throw new Error(`PCO API error ${res.status}: ${path}`);
  return res.json();
}

async function pcoGetAll(path) {
  let results = [], offset = 0;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await pcoGet(`${path}${sep}per_page=100&offset=${offset}`);
    results = results.concat(data.data || []);
    if (!data.meta?.next?.offset) break;
    offset = data.meta.next.offset;
  }
  return results;
}

async function parseRAPNote(rawNote) {
  if (!rawNote || rawNote.trim().length < 10) return { rundown: null, additions: null, prayer: null, raw: rawNote };
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: `Extract the RAP report sections from this connection group note. Return ONLY valid JSON with keys "rundown", "additions", "prayer". If a section is missing return null for that key. Do not include any other text.\n\nNote:\n${rawNote}\n\nJSON:` }]
    });
    const parsed = JSON.parse(response.content[0].text.trim());
    return { ...parsed, raw: rawNote };
  } catch (e) {
    console.warn("  RAP parse failed, storing raw:", e.message);
    return { rundown: null, additions: null, prayer: null, raw: rawNote };
  }
}

async function sync() {
  console.log("Starting Planning Center sync…");
  const startTime = Date.now();

  const allGroups = await pcoGetAll("/groups");
  const groupsRaw = allGroups.filter(g => g.attributes.name?.startsWith(GROUP_PREFIX));
  console.log(`Found ${allGroups.length} total groups, syncing ${groupsRaw.length} TSC CG groups\n`);

  const cutoff = new Date(Date.now() - DAYS_BEFORE_FLAG * 24 * 60 * 60 * 1000);
  const batch = db.batch();

  for (const g of groupsRaw) {
    try {
      const gid = g.id;
      const groupName = g.attributes.name || "";
      const shortName = groupName.replace(/^TSC CG:\s*/i, "");

      console.log(`  → ${shortName}`);

      const eventsRaw = await pcoGetAll(`/groups/${gid}/events`);
      eventsRaw.sort((a, b) => new Date(a.attributes.starts_at) - new Date(b.attributes.starts_at));

      const membersRaw = await pcoGetAll(`/groups/${gid}/memberships`);
      const memberCount = membersRaw.length;
      const leaderNames = membersRaw
        .filter(m => m.attributes.role === "leader")
        .map(m => `${m.attributes.first_name} ${m.attributes.last_name}`)
        .join(", ");

      const eventDocs = [];
      const attendanceHistory = [];
      let lastEventDate = null;

      for (const ev of eventsRaw) {
        const evDate = new Date(ev.attributes.starts_at);
        const attendanceRaw = await pcoGetAll(`/groups/${gid}/events/${ev.id}/attendances`);
        const attended = attendanceRaw.filter(a => a.attributes.attended).length;
        const noteRaw = ev.attributes.note || "";
        const parsedNote = noteRaw ? await parseRAPNote(noteRaw) : { rundown: null, additions: null, prayer: null, raw: "" };

        eventDocs.push({
          event_id: ev.id,
          date: Timestamp.fromDate(evDate),
          date_str: evDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
          attended_count: attended,
          note: parsedNote
        });

        attendanceHistory.push(attended);
        if (!lastEventDate || evDate > lastEventDate) lastEventDate = evDate;
      }

      const avgAttendance = attendanceHistory.length
        ? Math.round((attendanceHistory.reduce((s, v) => s + v, 0) / attendanceHistory.length) * 10) / 10
        : 0;
      const attendRate = memberCount ? Math.round((avgAttendance / memberCount) * 100) : 0;
      const flagged = lastEventDate ? lastEventDate < cutoff : true;
      const lastReportStr = lastEventDate
        ? lastEventDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "Never";

      batch.set(db.collection("groups").doc(gid), {
        short_name: shortName,
        full_name: groupName,
        leaders: leaderNames,
        members_count: memberCount,
        total_meetings: eventsRaw.length,
        avg_attendance: avgAttendance,
        attend_rate: attendRate,
        sparkline: attendanceHistory.slice(-8),
        flagged,
        last_report: lastReportStr,
        last_report_date: lastEventDate ? Timestamp.fromDate(lastEventDate) : null,
        events: eventDocs,
        updated_at: Timestamp.now()
      }, { merge: true });

      console.log(`  ✓ ${shortName} (${eventsRaw.length} events, last: ${lastReportStr})`);

    } catch (groupErr) {
      console.error(`  ✗ Error on group ${g.attributes?.name}:`, groupErr.message);
    }
  }

  batch.set(db.collection("meta").doc("sync"), {
    lastSync: Timestamp.now(),
    groupCount: groupsRaw.length
  });

  await batch.commit();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nSync complete in ${elapsed}s — ${groupsRaw.length} groups written to Firestore.`);
}

sync().catch(err => { console.error("Sync failed:", err.message); process.exit(1); });
