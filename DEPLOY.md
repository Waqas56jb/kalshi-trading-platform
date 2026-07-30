# Deploying to Vercel

`client/` and `server/` deploy as **two separate Vercel projects** from this one
repo. Each has its own `vercel.json` and its own dependencies.

---

## 1. Backend project

**New Project → import this repo → set Root Directory to `server`.**

Vercel picks up `server/vercel.json`, which routes every request into
`server/api/index.js` (the Express app) and registers the cron jobs.

### Environment variables

| name | value |
|---|---|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres` |
| `KALSHI_API_BASE` | `https://api.elections.kalshi.com/trade-api/v2` |
| `KALSHI_API_KEY_ID` | your Kalshi API key id |
| `KALSHI_PRIVATE_KEY` | the full PEM, `-----BEGIN…` to `-----END…` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_PROJECT_REF` | `<ref>` |
| `DB_TABLE_PREFIX` | `kalshi_` |
| `SERIES_TICKERS` | `KXITFMATCH,KXITFWMATCH` |
| `CRON_SECRET` | any long random string — guards the cron endpoints |
| `CORS_ORIGIN` | your frontend URL, e.g. `https://kalshi-trading-platform-user.vercel.app` |

Notes:

- **Do not set `NODE_ENV`.** Vercel sets it at runtime. Setting it to
  `production` makes npm skip devDependencies, which breaks builds.
- Percent-encode special characters in the DB password (`!` → `%21`).
- The private key is an env var rather than a file because a serverless
  filesystem has nowhere to keep a secret. Newlines pasted as literal `\n` are
  restored automatically.
- Any `*.vercel.app` origin is accepted by CORS, so `CORS_ORIGIN` is only needed
  for a custom domain.

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
