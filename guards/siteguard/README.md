# SiteGuard

Biometric access control for mines, construction and industrial sites — part of the HV-GUARD suite.

---

## Architecture

SiteGuard follows the HV-GUARD dual-collection pattern:

```
Camera → Base64 image
    ↓
Express proxy (hybrid-vector-api)
    ↓
siteguardApiKeyMiddleware  ←  x-api-key header
    ↓
/siteguard/* routes
    ↓
AWS Rekognition (parallel searches)
    ├── hv-siteguard-authorized  (workers enrolled to enter)
    └── hv-siteguard-blacklisted (banned individuals)
    ↓
Priority logic: BLACKLISTED > UNAUTHORIZED > AUTHORIZED
    ↓
Supabase persistence (siteguard_events, siteguard_workers, siteguard_blacklist)
```

---

## Endpoints

All routes are served by `hybrid-vector-api` under `/siteguard/*` and protected by `x-api-key`.

| Method   | Path                       | Description                              |
|----------|----------------------------|------------------------------------------|
| POST     | /siteguard/scan            | Scan a face — returns AUTHORIZED / UNAUTHORIZED / BLACKLISTED |
| POST     | /siteguard/enroll          | Enroll a worker into the authorized collection |
| POST     | /siteguard/blacklist       | Add a person to the blacklist collection |
| DELETE   | /siteguard/enroll/:faceId  | Remove a worker from authorized          |
| DELETE   | /siteguard/blacklist/:faceId | Remove from blacklist                  |
| GET      | /siteguard/status          | Collection sizes, thresholds, region     |
| GET      | /siteguard/events          | Last N scan events (filter: verdict, site_id) |
| GET      | /siteguard/workers         | Enrolled workers (filter: site_id)       |
| GET      | /siteguard/blacklist       | Blacklisted individuals                  |

---

## Verdict Logic

```
parallel search → blacklist collection (threshold: 90%)
              → authorized collection (threshold: 85%)

if blacklist match  → BLACKLISTED  (access denied)
elif authorized     → AUTHORIZED   (access granted)
else                → UNAUTHORIZED (access denied)
```

Priority is always: **BLACKLISTED > UNAUTHORIZED > AUTHORIZED**

---

## Environment Variables

| Variable                    | Default                        | Required |
|-----------------------------|--------------------------------|----------|
| `SG_API_KEY`                | `change-me`                    | ✅       |
| `SG_TENANT_ID`              | `siteguard-demo`               |          |
| `AWS_REGION`                | `af-south-1`                   | ✅       |
| `AWS_ACCESS_KEY_ID`         | —                              | ✅       |
| `AWS_SECRET_ACCESS_KEY`     | —                              | ✅       |
| `SG_COLLECTION_AUTHORIZED`  | `hv-siteguard-authorized`      |          |
| `SG_COLLECTION_BLACKLISTED` | `hv-siteguard-blacklisted`     |          |
| `SG_AUTHORIZED_THRESHOLD`   | `85`                           |          |
| `SG_BLACKLIST_THRESHOLD`    | `90`                           |          |
| `SUPABASE_URL`              | —                              | for persistence |
| `SUPABASE_SERVICE_ROLE_KEY` | —                              | for persistence |

---

## Supabase Schema

Run `supabase/migrations/20260422_siteguard_tables.sql` in the Supabase SQL editor.

Tables created:
- `siteguard_tenants` — API key auth + tenant ID
- `siteguard_events` — scan history (verdict, similarities, timestamps)
- `siteguard_workers` — enrolled worker registry
- `siteguard_blacklist` — blacklisted individuals

All tables have RLS enabled. The `app_backend` Postgres role has full access. Clients have no direct access.

---

## AWS IAM Permissions

The IAM user/role needs:

```json
{
  "Effect": "Allow",
  "Action": [
    "rekognition:SearchFacesByImage",
    "rekognition:IndexFaces",
    "rekognition:DeleteFaces",
    "rekognition:CreateCollection",
    "rekognition:DescribeCollection",
    "rekognition:ListFaces"
  ],
  "Resource": [
    "arn:aws:rekognition:af-south-1:*:collection/hv-siteguard-authorized",
    "arn:aws:rekognition:af-south-1:*:collection/hv-siteguard-blacklisted"
  ]
}
```

---

## Dashboard

Located at `guards/siteguard/dashboard/` — Next.js 14 app running on port 3009.

Pages:
- `/` — Home with status overview and navigation cards
- `/scan` — Live camera scan with verdict display
- `/workers` — Worker registry with unenroll action
- `/enroll` — Enroll a new worker (photo upload + metadata form)
- `/blacklist` — Manage blacklisted individuals
- `/events` — Event log with verdict and site filters

```bash
cd guards/siteguard/dashboard
npm install
NEXT_PUBLIC_API_URL=http://localhost:3000 NEXT_PUBLIC_SG_API_KEY=siteguard-key-2026 npm run dev
```

---

## Deployment (Fly.io)

The backend is shipped as part of `hybrid-vector-api`:

```bash
# Set secrets
fly secrets set SG_API_KEY=siteguard-key-2026 --app hybrid-vector-api

# Deploy
fly deploy --app hybrid-vector-api
```

The `/siteguard/*` routes are wired in `src/index.ts` and authenticated by `src/middleware/siteguardApiKey.ts`.
