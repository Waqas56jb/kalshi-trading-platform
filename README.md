# CourtEdge — UTR-driven Kalshi tennis trading desk

Prices every open ITF market on Kalshi from Universal Tennis Rating gaps, flags
the ones where the book has drifted from fair value, and executes on your
approval.

```
client/    React 19 · Vite 7 · Tailwind 4      the terminal UI
server/    Node 22 · Express 5 · Postgres      market sync, model, execution
```

There is **no mock data**. Prices come from the Kalshi Trade API, ratings from
UTR, and a fair value is only computed when both players in a match have a real
imported rating. Missing inputs render as `—`, never as a guess.

## Run it

```bash
# 1. backend
cd server
npm install
cp .env.example .env          # fill in Kalshi + Supabase credentials
npm run db:push               # create the kalshi_* tables
node cli/ratings.js           # import UTR ratings (~2 min for ~450 players)
npm run verify                # 18-check end-to-end health report
npm start                     # API on :8787 + sync loop every 15s

# 2. frontend
cd ../client
npm install
npm run dev                   # http://localhost:5173
```

`client/.env` sets `VITE_API_URL` (defaults to `http://localhost:8787`).

## How it works

1. **Sync** — every 15s the server pulls all open markets for the configured
   Kalshi series (`KXITFMATCH`, `KXITFWMATCH`) and upserts them. Each Kalshi
   *event* is one tennis match carrying two markets, one per player.
2. **Identify** — the market title is parsed into player, matchup, tournament,
   round and tour level (`M25 Edwardsville IL`, `Round of 16`, `M25`).
3. **Rate** — each competitor is resolved to a UTR profile by fuzzy name match,
   gated on gender and a confidence score. The profile id and score are stored so
   a bad match can be found later.
4. **Price** — the UTR gap maps to a fair win probability (Δ2.0→99¢, Δ1.0→85¢,
   Δ0.5→65¢, Δ0→50¢) and is compared to the live ask.
5. **Alert** — signals clearing your EV threshold open an alert.
6. **Execute** — approving an alert sends a fill-or-kill limit order at the ask,
   sized from your stake and capped by the volume actually available.

Every step is recorded: `kalshi_sync_runs` audits each pass,
`kalshi_price_history` keeps a tick whenever a quote moves, and `kalshi_trades`
records every order attempt including rejected ones.

## Database

Ten tables in the `public` schema, all prefixed `kalshi_`, so they cannot
collide with anything already in the project. RLS is on for every one with no
permissive policies — the anon/publishable key can read nothing. The browser
talks only to the Express API, never to Supabase directly.

See [server/README.md](server/README.md) for the schema, CLI reference, and
notes on the session-pooler connection.

## Known caveat: percentage EV on cheap contracts

EV is `(fair − ask) / ask`, which inflates sharply on longshots — a 1¢ model
error on a 3¢ ask reads as **+33% EV**. In live data the highest-EV rows are
therefore usually underdogs in the thinnest books. The API also returns
`edge_cents` (`fair − ask`); the UI shows both, and absolute edge is the more
honest ranking.
