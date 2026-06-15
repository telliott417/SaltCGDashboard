# Salt Company — Connection Group Dashboard

Staff dashboard for monitoring connection group health, attendance, and RAP notes. Pulls live data from Planning Center via API, stores in Firebase Firestore, served via GitHub Pages with Google OAuth (Candeo staff only).

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | HTML / CSS / JS — GitHub Pages |
| Database | Firebase Firestore |
| Auth | Firebase Auth — Google OAuth (candeo.church only) |
| Data source | Planning Center Groups API |
| Note parsing | Claude Haiku (Anthropic API) |

---

## Setup

### 1. Firebase

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Open your `salt-cg-dashboard` project
3. Enable **Firestore Database** (start in production mode)
4. Enable **Authentication** → Sign-in method → Google
5. Under Authentication → Settings → Authorized domains, add:
   - `telliott417.github.io`
6. Go to Project Settings → Service Accounts → Generate new private key
7. Save the downloaded JSON as `service-account.json` in this folder (never commit this)

### 2. Environment variables

Copy `.env.example` to `.env` and fill in your Anthropic API key:
```
cp .env.example .env
```
Get your Anthropic API key at [console.anthropic.com](https://console.anthropic.com)

### 3. Install sync dependencies

```bash
npm install
```

### 4. Run your first sync

```bash
npm run sync
```

This will pull all groups, events, attendance, and RAP notes from Planning Center and write them to Firestore. Expect it to take a few minutes the first time.

### 5. GitHub Pages

1. Push this repo to GitHub
2. Go to repo Settings → Pages
3. Set source to `main` branch, root folder
4. Your dashboard will be live at `https://telliott417.github.io/SaltCGDashboard/`

---

## Firestore data structure

```
groups/
  {group_id}/
    short_name:       "Alberts / Vicker"
    full_name:        "TSC CG: Alberts / Vicker"
    leaders:          "Elise Alberts, Sophia Vicker"
    members_count:    20
    total_meetings:   16
    avg_attendance:   12.0
    attend_rate:      60
    sparkline:        [9, 12, 12, 12, 12, 12, 11, 13]
    flagged:          false
    last_report:      "May 06"
    events: [
      {
        event_id:       "..."
        date:           Timestamp
        date_str:       "May 6, 2026"
        attended_count: 12
        note: {
          rundown:    "We studied Psalm 23..."
          additions:  "Sarah joined for the first time"
          prayer:     "Finals week, Emma's family"
          raw:        "R - We studied..."
        }
      }
    ]

meta/
  sync/
    lastSync:    Timestamp
    groupCount:  43
```

---

## Pages

| Page | Description |
|---|---|
| `index.html` | Login / auth wall |
| `dashboard.html` | Main staff dashboard |
| `group.html?id={id}` | Group detail — RAP notes, attendance chart, members |
| `admin.html` | Coach assignments, sync controls |

---

## Roadmap

- [x] Phase 1 — Auth + skeleton
- [ ] Phase 2 — Planning Center sync pipeline
- [ ] Phase 3 — Main dashboard (live data)
- [ ] Phase 4 — Group detail page
- [ ] Phase 5 — Coach view + Admin panel
