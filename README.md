# LoadMatch Backend (MVP)

Zero-dependency Node.js backend for the LoadMatch frontend. Uses only Node
built-ins: `http`, `node:sqlite` (Node 22.5+), `crypto`. No `npm install`
required — that's not a shortcut, it's a fix, since this sandbox (and maybe
your dev machine) can't hit the npm registry.

## Run it locally

```bash
node --version   # need 22.5+ for node:sqlite
node seed.js     # creates data/loadmatch.db with demo users/trucks/loads
node server.js   # listens on :4000 by default
```

Demo logins (password `demo1234` for all):
- Carrier: `kwame@asantehaulage.example`
- Shipper: `ama@owusufurniture.example`

## Connecting to your live frontend (empty-trackload.onrender.com)

Your frontend is a **static site** — it can't run this backend itself. You
need a second Render service:

1. **Push this `backend/` folder to a repo** (or a `backend/` subfolder of
   your existing repo).
2. On Render: **New → Web Service** (not Static Site), point it at that repo/folder.
   - Build command: (leave blank — nothing to build)
   - Start command: `node seed.js && node server.js` (seed is a no-op if data already exists, so this is safe on redeploy)
   - Environment: add `CORS_ORIGIN=https://empty-trackload.onrender.com`
3. **⚠️ SQLite persistence on Render:** Render's free/standard web services
   have an **ephemeral filesystem** — anything written to disk (including
   `data/loadmatch.db`) is wiped on every redeploy or restart. For a real
   deployment, either:
   - attach a [Render Disk](https://render.com/docs/disks) (paid, persistent
     volume) and set `DB_PATH=/var/data/loadmatch.db` pointing into it, or
   - swap SQLite for a managed Postgres (Render has a free Postgres tier) —
     bigger change, ask me and I'll port `db.js` to it.
   For a demo/portfolio deploy, ephemeral storage is fine — just know a
   redeploy resets everyone's data back to the seed.
4. Once deployed, you'll get a URL like `https://loadmatch-backend.onrender.com`.
   In your frontend, set it before `api-client.js` loads:
   ```html
   <script>window.LOADMATCH_API_BASE = 'https://loadmatch-backend.onrender.com';</script>
   <script src="assets/js/api-client.js"></script>
   ```
5. **Cold starts:** Render's free tier spins down idle web services. The
   first request after idle can take 30–60s. Fine for a demo; if it matters,
   upgrade the plan or ping a `/api/health` keep-alive from an external cron.

## API reference

All responses are JSON. Authenticated routes take `Authorization: Bearer <token>`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | — | `{ role, ownerName, company?, email, phone, password }` |
| POST | `/api/auth/login` | — | `{ email, password }` |
| GET | `/api/me` | ✓ | current user |
| POST | `/api/trucks` | carrier | create truck (status starts `pending`) |
| GET | `/api/trucks` | — | filter by `?from=&to=&status=` |
| POST | `/api/trucks/:id/verify` | admin | `{ decision: 'verified'|'rejected' }` |
| POST | `/api/loads` | shipper | create load |
| GET | `/api/loads` | — | filter by `?from=&to=&status=` |
| GET | `/api/pricing/estimate` | — | `?from=&to=&ratePerKmGhs=&weightKg=&volumeM3=&verified=` |
| GET | `/api/matches/run` | — | preview-only scored candidates, nothing persisted |
| POST | `/api/matches` | ✓ | `{ truckId, loadId }` persists a match |
| GET | `/api/matches` | ✓ | your matches (as carrier or shipper) |
| GET | `/api/matches/:id` | ✓ | one match + truck + load |
| POST | `/api/matches/:id/accept` | ✓ | `proposed` → `accepted` |
| PATCH | `/api/matches/:id/commission` | admin | `{ commissionPct }`, 3–10 |
| POST | `/api/matches/:id/contract` | ✓ | generates contract text |
| POST | `/api/matches/:id/contract/sign` | ✓ | `{ signatureName }`; both signed → `contracted` |
| POST | `/api/matches/:id/escrow/fund` | shipper | `contracted` → `in_transit`, creates payment |
| GET | `/api/matches/:id/payment` | ✓ | payment status/amounts |
| POST | `/api/matches/:id/tracking` | carrier | `{ lat, lng, note? }` |
| GET | `/api/matches/:id/tracking` | ✓ | breadcrumb list |
| POST | `/api/matches/:id/pod/request-otp` | carrier | `in_transit` only; returns `devOnlyOtp` (see below) |
| POST | `/api/matches/:id/pod/verify` | ✓ | `{ otp }`; correct OTP → `delivered`/`paid`, releases escrow |
| GET | `/api/health` | — | liveness check |

## Before production

1. **`devOnlyOtp`** in the POD request response is there because there's no
   SMS gateway wired up. Replace with a real SMS provider (e.g. Twilio,
   Africa's Talking) and delete that field from the response — right now
   anyone with match access can read the OTP from the API response.
2. **Escrow is a simulation.** `escrow/fund` just flips a status — no money
   moves. Wire up Paystack/Flutterwave (per the frontend README) and only
   mark `escrowed` after a verified webhook from the processor.
3. **`routeDistanceKm()` in `matching.js`** uses a hardcoded 8-city estimate
   table, same as the frontend. Swap for Google Routes/Directions API,
   Mapbox, or OSRM for real distances.
4. **Admin role**: there's no signup path for `role: 'admin'` — insert one
   directly via SQL for now (`sqlite3 data/loadmatch.db "UPDATE users SET
   role='admin' WHERE email='you@example.com'"`) or add a proper admin
   invite flow before launch.
5. **Rate limiting / abuse protection** isn't implemented at the API layer
   (the frontend has its own honeypot/CAPTCHA on forms, but the backend
   itself will happily accept scripted requests) — add basic rate limiting
   before this is public.
