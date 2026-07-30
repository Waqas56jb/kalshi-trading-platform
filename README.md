# CourtEdge — UTR-driven Kalshi tennis trading desk

Prices every open ITF market on Kalshi from Universal Tennis Rating gaps, flags
the ones where the book has drifted from fair value, and executes on your
approval.

```
client/    React 19 · Vite 7 · Tailwind 4      the terminal UI
server/    Node 22 · Express 5 · Postgres      market sync, model, execution
```

Two folders, deployed as two independent Vercel projects. Each is self-contained:
its own dependencies, its own `vercel.json`, nothing shared at the repo root.

There is **no mock data**. Prices come from the Kalshi Trade API, ratings from
UTR, and a fair value is only computed when both players in a match have a real
imported rating. Missing inputs render as `—`, never as a guess.

---

## Run it

```bash
# backend
cd server
npm install
cp .env.example .env          # fill in Kalshi + Supabase credentials
npm run db:push               # create the kalshi_* tables
node cli/users.js seed        # first admin, from SEED_ADMIN_* in .env
node cli/ratings.js           # import UTR ratings (~2 min for ~450 players)
npm run verify                # end-to-end health report
npm start                     # API on :8787 + sync loop every 15s

# frontend
cd ../client
npm install
npm run dev                   # http://localhost:5173
```

`client/.env` sets `VITE_API_URL` (defaults to `http://localhost:8787`).

---

## How it works

1. **Sync** — pulls every open market for the configured Kalshi series
   (`KXITFMATCH`, `KXITFWMATCH`). Each Kalshi *event* is one match carrying two
   markets, one per player.
2. **Identify** — the title is parsed into player, matchup, tournament, round and
   tour level.
3. **Rate** — each competitor is resolved to a UTR profile by fuzzy name match,
   gated on gender and a confidence score. The profile id and score are stored so
   a bad match can be found later.
4. **Price** — the UTR gap maps to a fair win probability (Δ2.0→99¢, Δ1.0→85¢,
   Δ0.5→65¢, Δ0→50¢) and is compared to the live ask.
5. **Alert** — signals clearing every guard open a pre-match alert.
6. **Execute** — approving sends a fill-or-kill limit order at the ask, sized from
   your stake and capped by the volume actually available.

### Timing: what the desk knows and what it doesn't

Kalshi publishes **no match start time**. Its `occurrence_datetime` is identical to
`expected_expiration_time` — an expiry estimate. On a checked ITF match it read
18:00 while play actually began at 13:27.

So the desk reports only what it can establish:

| | Source | Reliable |
|---|---|---|
| Match **day** | the ticker (`KXITFMATCH-26JUL30…`) | yes — agreed with Kalshi's date on 366/400 markets |
| **Play state** | order-book volume growth | yes — measured |
| Exact **clock time** | none available | not shown rather than guessed |

Play state is inferred from the book because it is the only honest signal
available: while ITF M25 Koszalin was under way, markets in play had grown
48,047 / 17,936 / 1,182 contracts over three hours, while markets yet to start had
grown 0 / 0 / 9.

A real countdown needs a schedule feed. Sofascore returns 403 to servers and the
ITF site serves a bot-protection page, so it needs a provider with an API — The
Odds API's `commence_time` would supply start times and bookmaker odds from one key.

### Signal guards

Live data showed the model's largest disagreements with the market are where it is
most likely *wrong* — a withdrawal looks identical to a huge edge. Configurable in
Settings:

- minimum bid (a 0/1¢ quote is not a market)
- maximum spread
- maximum believable edge — beyond it, defer to the market
- pre-match only, with a minimum lead time
- in-play volume threshold

Signals also carry `side_type` (favourite / underdog / pick'em) because the model
overwhelmingly flags underdogs, and that skew is worth seeing.

---

## Deployment

Two Vercel projects from this one repo.

### Backend — Root Directory `server`

Serverless functions plus a small status page; no build step. A `"/api/:path*"`
rewrite sends every request into `server/api/index.js`. **Do not** use an
`api/[...slug].js` catch-all: in a non-framework project it matches only one
segment, so `/api/health` works while `/api/alerts/12/dismiss` 404s.

| variable | value |
|---|---|
| `DATABASE_URL` | Supabase **transaction** pooler, port **6543** |
| `MIGRATION_DATABASE_URL` | session pooler, port 5432 (DDL only) |
| `KALSHI_API_KEY_ID` | your Kalshi API key id |
| `KALSHI_PRIVATE_KEY` | the full PEM, `-----BEGIN…` to `-----END…` |
| `KALSHI_API_BASE` | `https://api.elections.kalshi.com/trade-api/v2` |
| `AUTH_SECRET` | long random string; signs session tokens |
| `CRON_SECRET` | long random string; guards the cron endpoints |
| `DB_TABLE_PREFIX` | `kalshi_` |
| `NODE_ENV` | `production` |

- **Never set `KALSHI_PRIVATE_KEY_PATH`** — the `.pem` is gitignored and never
  deployed, so the read throws at module load and every route dies.
- Use port **6543**. Session mode (5432) caps the whole project at 15 clients,
  which serverless containers plus cron exhaust.
- Percent-encode special characters in the password (`!` → `%21`).

### Frontend — Root Directory `client`

| variable | value |
|---|---|
| `VITE_API_URL` | `https://<backend>.vercel.app` |

Baked in at build time, so changing it needs a redeploy. **Never set `NODE_ENV`
here** — npm then skips devDependencies and `vite` disappears.

### Verify every depth, not just `/api/health`

```bash
B=https://<backend>.vercel.app
curl -s -o /dev/null -w '%{http_code}\n' "$B/api/health"                    # 200
curl -s -o /dev/null -w '%{http_code}\n' "$B/api/markets/<ticker>/history"  # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/api/sync"              # 401
```

### Keeping data fresh

Vercel Cron on the Hobby plan runs at most **once per day**, so
`server/vercel.json` schedules that as a safety net only. For a real cadence:

- **GitHub Actions** — `.github/workflows/sync.yml` calls `/api/sync` every 5
  minutes. Set repository secrets `DEPLOY_URL` and `CRON_SECRET`.
- **Vercel Pro** — allows `* * * * *`; then delete the workflow.
- **Your machine** — `cd server && npm run sync -- --loop` keeps the 15s cadence.

---

## Database

Fourteen tables in `public`, all prefixed `kalshi_`, so they cannot collide with
anything already in the project. RLS is on for every one with no permissive
policies — the anon key reads nothing. The browser talks only to the Express API.

See [server/README.md](server/README.md) for the schema and CLI reference.

---

## Security

Accounts are real: scrypt password hashes, HS256 session tokens, and every data
and trading route behind authentication. `/users` and `PATCH /settings` also
require the admin role. Only `/health` and `/auth/login` are public.

Credentials live in `server/.env`, which is gitignored along with `*.pem`. Nothing
secret is ever sent to the browser.

---

## Repository layout

Only `client/`, `server/` and this file sit at the root. Two others must stay
where they are:

- **`.gitignore`** — git only honours it at the root. Without it `server/.env` and
  the Kalshi private key would be committed.
- **`.github/workflows/`** — GitHub reads workflows only from this exact path.
  Delete it if you do not want the 5-minute sync.
