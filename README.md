# Backend — MAUSAM GRID API

Node.js + Express + MongoDB + Socket.IO API for the National Weather Big Data
Analytics Platform.

## Setup

```bash
npm install
cp .env.example .env      # edit MONGODB_URI if using Atlas instead of local mongod; set real JWT secrets
npm run seed               # optional: populate ~300 realistic sample reports
npm run create-admin "Your Name" admin@example.com "StrongPass123"   # bootstrap the first super_admin
npm run dev                 # nodemon, restarts on file change
# or: npm start
```

Environment variables (`.env`):

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/weather_platform` | MongoDB connection string |
| `PORT` | `8000` | API/Socket.IO port |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated allowed origins for the frontend |
| `AUTOSTART_SIMULATOR` | `false` | if `true`, starts the synthetic ingestion simulator automatically on boot |

## REST API reference

### Auth

- `POST /api/auth/signup` — body `{ name, email, password }`. Always creates a
  `citizen` account. Password must be 8+ chars with an uppercase letter and a
  number. Returns `{ user, accessToken }` and sets an httpOnly refresh cookie.
- `POST /api/auth/login` — body `{ email, password }`. Rate-limited (20/15min per
  IP) plus a per-account lockout after 5 failed attempts (15 min). Returns
  `{ user, accessToken }`.
- `POST /api/auth/refresh` — reads the httpOnly refresh cookie, returns a new
  `{ user, accessToken }`. Called automatically by the frontend on page load and
  on any 401.
- `POST /api/auth/logout` — clears the refresh cookie.
- `GET /api/auth/me` — requires `Authorization: Bearer <accessToken>`. Returns the
  current user.
- `POST /api/auth/admin-create` — **super_admin only**. body
  `{ name, email, password, role: "district_admin"|"state_admin", state }`.
  Creates a scoped admin account.

Every route below except the read-only `GET` endpoints requires
`Authorization: Bearer <accessToken>`.

### Reports

- `POST /api/reports` — ingest one report. Body:
  ```json
  {
    "source": "twitter",
    "sourceUrl": "https://...",
    "authorHandle": "user123",
    "authorFollowers": 500,
    "authorAccountAgeDays": 400,
    "authorVerifiedBadge": false,
    "rawText": "Heavy rainfall in Mumbai #IMD #rain",
    "hashtags": ["#IMD", "#rain"],
    "postedAt": "2026-09-26T10:00:00Z",
    "city": "Mumbai",
    "state": "Maharashtra",
    "latitude": 19.076,
    "longitude": 72.8777,
    "mediaPhotoUrl": "https://..."
  }
  ```
  Returns the saved report, already classified, scored and deduplicated, and
  broadcasts it over Socket.IO as `report:new`. **Smart triage:** if the source is
  `imd_api` or `news_verified` and the computed credibility score is ≥ 80, the
  report is auto-verified on arrival (`verifiedBy: "auto-verification-system"`) and
  never enters the human review queue at all.

- `GET /api/reports` — list/filter. Query params: `dateFrom`, `dateTo`,
  `eventCategory` (comma-separated for multi-select), `state`, `city`,
  `verificationStatus`, `isDuplicate`, `search`, `limit`, `offset`.

- `GET /api/reports/:id` — fetch one report.

- `PATCH /api/reports/:id/verify` — **requires district_admin or above**, and the
  report's `state` must match the caller's assigned state (super_admin bypasses
  this check). Body: `{ "verificationStatus": "verified"|"rejected"|"needs_review"|"pending", "adminNotes": "..." }`.
  `verifiedBy` is taken from the authenticated user automatically. **Cluster-level
  verification:** this decision is applied to every report in the same duplicate
  cluster in one write, not just the targeted report — the response is
  `{ report, updatedCount, updatedReports }`. Broadcasts a `report:updated` event
  per updated report over Socket.IO, adjusts each report's author's Reporter Trust
  Network score, and writes an `AuditLog` entry.

- `PATCH /api/reports/bulk-verify` — **requires district_admin or above**. Body:
  `{ "ids": ["<reportId>", ...], "verificationStatus": "...", "adminNotes": "..." }`
  (max 200 ids per call). Applies one decision to many selected reports at once
  from the Admin Panel, each still individually state-scope-checked and
  cluster-cascaded. Response: `{ updatedCount, updatedReports, skipped }`.

### Analytics

- `GET /api/stats?hours=24` — aggregate totals, breakdowns by event/state/severity,
  and an hourly timeline.
- `GET /api/anomalies` — the Emerging Event Radar feed: ranked hotspots where
  report velocity is spiking above baseline and independently corroborated.

### Meta

- `GET /api/meta/states` / `GET /api/meta/cities?state=...` — distinct values for
  filter dropdowns.
- `GET /api/meta/reporters/leaderboard` — top reporters by trust score.

### Simulator control (development/demo only)

- `POST /api/simulate/start?ratePerMin=40` — requires district_admin or above.
- `POST /api/simulate/stop` — requires district_admin or above.
- `GET /api/simulate/status` — public.

## Socket.IO events

- `report:new` — emitted whenever a report is ingested (via API or simulator).
- `report:updated` — emitted whenever a report's verification status changes.

## Code map

- `src/models/User.js` — accounts, roles, password hashing, lockout state.
- `src/models/AuditLog.js` — audit trail of logins and verification decisions.
- `src/middleware/auth.js` — JWT verification, `requireRole()`, state-scoping guard.
- `src/utils/tokens.js` — access/refresh token signing and verification.
- `src/utils/createSuperAdmin.js` — bootstrap script (`npm run create-admin`).
- `src/routes/auth.js` — signup, login, refresh, logout, me, admin-create.
- `src/ml/pipeline.js` — event classification, credibility scoring, deduplication.
- `src/ml/anomaly.js` — Emerging Event Radar velocity/corroboration detector.
- `src/services/ingestService.js` — the single pipeline every report passes
  through, whether it arrives via the API or the simulator.
- `src/ingestion/simulator.js` — synthetic multi-source report generator.
- `src/ingestion/runner.js` — background loop driving the simulator.
- `src/ingestion/seed.js` — one-off script to populate the database (`npm run seed`).

## Testing the ML logic without a database

`src/ml/pipeline.js` and `src/ml/anomaly.js` have no MongoDB dependency and can be
required and called directly, e.g.:

```bash
node -e "console.log(require('./src/ml/pipeline').classifyEvent('Heavy rainfall in Mumbai #IMD'))"
```
