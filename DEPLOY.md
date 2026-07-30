# Deploying to Vercel

`client/` and `server/` deploy as **two separate Vercel projects** from this one
repo. Each has its own `vercel.json` and its own dependencies.

---

## 1. Backend project

**New Project → import this repo → set Root Directory to `server`.**

Vercel picks up `server/vercel.json`. There is no build step — the project is
serverless functions plus a small static page:

- A `"/api/:path*"` rewrite sends every `/api` request at any depth into
  `server/api/index.js`. **Do not replace this with an `api/[...slug].js`
  catch-all**: in a non-framework project that matches only one segment, so
  `/api/health` works while `/api/alerts/12/dismiss` and
  `/api/markets/:ticker/history` return a platform 404 without ever reaching the
  function — silently breaking half the API in production only.
- `outputDirectory` is `public`, which both satisfies Vercel's build check and
  keeps `src/` from being served as static files.
- Routes are mounted at both `/api` and `/`, so the API answers regardless of
  whether the platform preserves the path.

### Verify every depth, not just `/api/health`

```bash
B=https://<backend>.vercel.app
curl -s -o /dev/null -w '%{http_code}\n' "$B/api/health"                      # 200
curl -s -o /dev/null -w '%{http_code}\n' "$B/api/markets?limit=1"             # 200
curl -s -o /dev/null -w '%{http_code}\n' "$B/api/markets/<ticker>/history"    # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/api/sync"                # 401
```

A single-segment check alone would have passed while nested routes were broken.

### Environment variables

Do **not** paste `server/.env` wholesale. Half of it is for local development
only, and one line actively breaks the deployment. These are the variables the
backend actually reads in production:

| name | value | why |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres` | required |
| `KALSHI_API_KEY_ID` | your Kalshi API key id | required |
| `KALSHI_PRIVATE_KEY` | the full PEM, `-----BEGIN…` to `-----END…` | required |
| `KALSHI_API_BASE` | `https://api.elections.kalshi.com/trade-api/v2` | required |
| `DB_TABLE_PREFIX` | `kalshi_` | required |
| `SERIES_TICKERS` | `KXITFMATCH,KXITFWMATCH` | optional, this is the default |
| `CRON_SECRET` | any long random string | guards the cron endpoints |
| `NODE_ENV` | `production` | without it CORS accepts any localhost origin |
| `CORS_ORIGIN` | your frontend URL | only needed for a custom domain; any `*.vercel.app` is already allowed |

**Never set `KALSHI_PRIVATE_KEY_PATH` on Vercel.** The `.pem` it points at is
gitignored and never deployed, so the read throws while the module is loading and
every route dies with `FUNCTION_INVOCATION_FAILED`. Use `KALSHI_PRIVATE_KEY`
instead — literal `\n` in the pasted value is restored automatically.

`NODE_ENV=production` is correct here but **must not be set on the frontend
project**, where it makes npm skip devDependencies and `vite` disappears.

These lines from `.env` do nothing in production and can be left out: `PORT`
(serverless assigns its own), `POLL_INTERVAL_MS` (only the in-process sync loop
uses it), `MIN_EV_THRESHOLD`, `STAKE_PER_TRADE`, `MAX_EXPOSURE_PER_MATCH` (read
from the `kalshi_settings` table, not the environment), `SUPABASE_DB_PASSWORD`
and `SUPABASE_PUBLISHABLE_KEY` (the backend only uses `DATABASE_URL`).

Percent-encode special characters in the DB password (`!` → `%21`).

### Confirm it works

```bash
curl https://<backend>.vercel.app/api/health
```

Expect `ok: true`, `db.ok: true`, and `kalshi.marketData: "ok"`.

---

## 2. Frontend project

**New Project → same repo → set Root Directory to `client`.**

### Environment variable

| name | value |
|---|---|
| `VITE_API_URL` | `https://<backend>.vercel.app` |

This is compiled into the bundle at build time, so **changing it requires a
redeploy**. Without it the dashboard has no backend to call and says so.

---

## 3. Database

Run once from your machine, against the same Supabase project:

```bash
cd server
npm run db:push          # creates the 10 kalshi_* tables
node cli/ratings.js      # imports UTR ratings
npm run verify           # confirms every layer
```

`db:push` uses the Supabase CLI with `--db-url`, which needs no `supabase login`.

---

## 4. Keeping data fresh

Vercel Cron on the **Hobby** plan runs at most **once per day**, which is why
`server/vercel.json` schedules the daily job — it is a safety net, not the real
cadence.

For a useful cadence, pick one:

- **GitHub Actions** — `.github/workflows/sync.yml` calls `/api/sync` every 5
  minutes. Set two repository secrets under Settings → Secrets → Actions:
  `DEPLOY_URL` (your backend URL) and `CRON_SECRET` (same value as the backend).
  This only works if the backend deployment is publicly reachable.
- **Vercel Pro** — allows `* * * * *` in `server/vercel.json`; then delete the
  workflow.
- **Your own machine** — `cd server && npm run sync -- --loop` keeps the 15s
  cadence the code was written for.

---

## Security before you go live

Two things to settle **before** the Kalshi credentials start working:

1. **The API has no authentication.** `POST /api/alerts/:id/execute` places a real
   order. Anyone who can reach the backend URL can call it. Cron endpoints are
   guarded by `CRON_SECRET`; the trading endpoints are not.
2. **The login screen is decorative.** It accepts any email and password — it came
   from the original static mockup and gates nothing.

Until both are fixed, keep Vercel's Deployment Protection **on** for the backend
project, which restricts it to your Vercel account. Note that this also blocks
external cron callers such as GitHub Actions.
