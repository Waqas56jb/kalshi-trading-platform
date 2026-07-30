# CourtEdge — server

Node 22 · Express 5 · Postgres (Supabase) · Kalshi Trade API v2 · UTR ratings.

No mock data exists anywhere in this service. Every price comes from Kalshi,
every rating from UTR, and every fair value is computed from a rating that was
actually imported. When an input is missing the API returns `null` — it never
substitutes a guess.

```bash
npm install
cp .env.example .env      # then fill in the secrets
npm run db:push           # create the kalshi_* tables
node cli/ratings.js       # import UTR ratings for discovered players
npm run sync              # one sync pass
npm run verify            # end-to-end health check
npm start                 # API + background sync loop
```

## CLI

| command | what it does |
|---|---|
| `npm run verify` | 18 checks across config, DB, Kalshi, model and stored data. Exits non-zero on failure. `--json` for machine output. |
| `npm run db:push` | Applies `supabase/migrations/*.sql` to the remote project. |
| `npm run db:status` | Table list with row counts, RLS state, migration history. |
| `npm run db:reset -- --yes` | Drops **only** the `kalshi_*` tables. |
| `npm run sync` | One sync pass. `--loop` to poll continuously. |
| `node cli/ratings.js` | Imports UTR ratings. `--retry` re-attempts players that previously missed. |

## Database

Ten tables, all prefixed `kalshi_` so they cannot collide with anything already
in the project. RLS is enabled on every one with **no** permissive policies, so
the publishable/anon key can read nothing; the backend connects as `postgres`
and is not subject to RLS. The browser never talks to Supabase directly.

```
kalshi_players               competitors + their imported UTR rating and provenance
kalshi_events                one row per tennis match
kalshi_markets               one row per player per match, prices in integer cents
kalshi_price_history         a tick whenever a quote or volume actually changes
kalshi_signals               model output: fair value, edge, EV, actionable flag
kalshi_alerts                actionable signals awaiting your approval
kalshi_trades                every order attempt, including rejected ones
kalshi_settings              single-row strategy config
kalshi_sync_runs             audit trail of every sync pass
kalshi_portfolio_snapshots   balance/exposure, populated once Kalshi auth works
```

Connection uses the **session pooler** (`aws-1-ap-south-1`). The direct host
`db.<ref>.supabase.co` is IPv6-only and unreachable from most networks. Special
characters in the password must be percent-encoded (`!` → `%21`).

## The model

`fairFromGap` in `src/model.js` maps a UTR rating gap to a fair win probability,
the same curve documented on the landing page:

| UTR gap | fair |
|---|---|
| Δ2.0+ | 99¢ |
| Δ1.0 | 85¢ |
| Δ0.5 | 65¢ |
| Δ0.0 | 50¢ |

A negative gap mirrors the curve. `fairFromGap(null)` returns `null` — a market
whose players are not both rated is shown unpriced, never guessed.

### A caveat about percentage EV

EV is `(fair − ask) / ask`, which inflates violently on cheap contracts: a 1¢
model error on a 3¢ ask reads as **+33% EV**. In live data the highest-EV rows
are therefore almost always longshots in the thinnest books. The API also
returns `edge_cents` (`fair − ask`), which is the honest magnitude. Rank on that.

## Kalshi authentication

Requests are signed RSA-PSS/SHA-256 over `timestamp + METHOD + path`, salt
length equal to the digest length. Market data (`/markets`, `/events`,
`/series`, orderbooks) needs no authentication and always works. Portfolio and
order endpoints do.

If `npm run verify` warns that the signature is rejected, the private key in
`kalshi_private_key.pem` does not correspond to the public key registered
against `KALSHI_API_KEY_ID`. Order attempts are still recorded, with status
`failed` and the exchange's own reason, so the ledger never loses an attempt.

## API

```
GET  /api/health                     db, kalshi, sync, ratings coverage
GET  /api/markets?filter=&search=    filter: all|mispriced|rated|inplay
GET  /api/markets/:ticker/history
GET  /api/alerts?status=open
POST /api/alerts/:id/dismiss
POST /api/alerts/dismiss-all
POST /api/alerts/:id/execute         places a real fill-or-kill order
GET  /api/trades?filter=all|open|won|lost
GET  /api/overview?days=30
GET  /api/analytics?days=30
GET  /api/pnl?days=30
GET  /api/settings
PATCH /api/settings
POST /api/sync                       force a sync pass
POST /api/portfolio/snapshot
POST /api/trades/reconcile
```

## Resilience

- Kalshi calls: 20s timeout, retried twice with backoff on network faults, 429
  and 5xx. Auth and other 4xx fail fast.
- Postgres: the pool recycles at 10s, ahead of the pooler's own idle timeout,
  and transient connection errors are retried once.
- Sync runs abandoned by a crash are reaped on boot so the dashboard never
  reports a sync as permanently in flight.
- A failing sync never stops the loop.
