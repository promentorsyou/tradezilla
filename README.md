# TradeZilla

A trading journal for Coinbase. Reconstructs round-trip trades from your
account activity and renders a dashboard, day view, trade log, positions,
reports and a P&L calendar.

**[▶ Live journal](https://promentorsyou.github.io/tradezilla/)**

![Dashboard](docs/screenshot-dashboard.png)

---

## Security

This repository contains **no credentials**, and it never should. It does
publish the owner's real portfolio figures at `docs/index.html`, by their
explicit choice — numbers only, no access.

- The API client (`journal/cb_client.py`) exposes **HTTP GET only**. It cannot
  place, modify or cancel an order even if you asked it to.
- Use a **View-only** Coinbase API key. Nothing here needs trade permission.
- Credentials are read from **environment variables**. There is no config file
  to accidentally commit.
- The published page shows the owner's real figures by their own choice. It
  contains **no credentials** and grants no account access. Run
  `export_static.py --sample` for a build on generated data instead.
- `.gitignore` blocks the cache of raw fills and every generated build under
  `journal/dist/`. Only what is deliberately copied into `docs/` is published.

Your key stays on your machine. Nothing is uploaded anywhere.

---

## Run it

```bash
git clone https://github.com/promentorsyou/tradezilla
cd tradezilla/journal
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt

export COINBASE_API_KEY_NAME="organizations/<org>/apiKeys/<key-id>"
export COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"

./venv/bin/python server.py --warm
```

Open **http://127.0.0.1:8000**.

Want to look around first? No key required:

```bash
./venv/bin/python export_static.py --sample   # writes dist/sample.html
```

---

## Views

| View | What it shows |
|---|---|
| **Dashboard** | Net P&L, win %, profit factor, day win %, Zella score, cumulative P&L, daily P&L, drawdown, heatmap, balance, open positions, recent trades |
| **Day View** | One expandable card per trading day |
| **Trade View** | Every round-trip trade, sortable and filterable |
| **Positions** | Live holdings, open orders, cost basis vs mark |
| **Reports** | Full metrics, P&L reconciliation, fee tier, per-symbol, P&L by hour and weekday |
| **Calendar** | Monthly calendar with per-day and per-week P&L |

Light and dark themes. Charts are hand-rolled SVG — no chart library, no CDN,
no tracking.

---

## How a "trade" is defined

Coinbase gives you fills, not trades. This reconstructs round trips:

- A trade **opens** when a position leaves flat and **closes** when it returns
  to flat. Many buys and sells collapse into one trade with a weighted-average
  entry and exit.
- Matching is **HIFO**, tracked **per asset** — `BTC-USD` and `BTC-USDC` are the
  same coins in the same wallet.
- `net_pnl = exit proceeds − HIFO cost of units sold − commissions`, using
  Coinbase's real per-fill commission rather than an assumed fee tier.

### Cost-basis method

Lots are relieved **HIFO** by default, matching the Coinbase account setting
(Settings → cost-basis method). Override with `COST_BASIS=FIFO` if your account
uses FIFO instead.

This does not change the account's value or its total return — it changes how
much of the result is booked as **realized** versus left in the **open
position**, and it changes what your 1099-DA will say. On an account that
trades the same asset in and out repeatedly the gap is large: FIFO relieves the
oldest, cheapest lots, reporting big gains while leaving the expensive coins
open; HIFO relieves what you most recently paid, so each trade shows the result
of the trade you actually made.

### Two data sources, on purpose

The Advanced Trade fills endpoint only returns Advanced orders. Trades from the
simple Buy/Sell screen, conversions and reward payouts live in the v2 account
ledger. Using fills alone leaves sells whose matching buys are missing, which
reads as **phantom profit** — on the account this was built against, that error
was about **$28,000**.

`events.py` merges both and drops the v2 `advanced_trade_fill` rows that would
otherwise double-count. It also handles **clawbacks** (a reversed funding
payment takes back the coins too, so the position must shrink), **rewards**
(booked at the USD value Coinbase reported at receipt) and **dust** (sub-$1
remainders shouldn't keep a finished trade open forever).

---

## It checks its own arithmetic

Every build proves:

```
net invested + realized (closed) + realized (partial exits) + unrealized + income
    ==  portfolio value
```

The Reports page shows this line by line including any **unexplained residual**,
and the header badge reads ✓ Reconciled or ⚠ Check reconciliation. The residual
is displayed rather than hidden: Coinbase bakes a spread into simple-interface
prices that is not itemised anywhere in the API, so a small residual is expected
and honest.

---

## Publishing your own

```bash
./venv/bin/python export_static.py --both
```

| Output | Contains | Share it? |
|---|---|---|
| `dist/index.html` | your real balances | only if you mean to |
| `dist/demo.html` | same trades, all dollar amounts rescaled by one constant | your call |
| `dist/sample.html` | invented data | yes |

`--demo` multiplies every dollar figure by a single factor, so win rate, profit
factor, ratios and history stay exactly true while balances aren't disclosed.

`docs/` is served by GitHub Pages and currently holds the **real** build.

---

## Layout

```
journal/
  cb_client.py       read-only Coinbase client (GET only, env-var creds)
  events.py          merges Advanced fills + v2 ledger into one event stream
  engine.py          lot-matched trade building, analytics, reconciliation
  server.py          stdlib HTTP server + JSON API
  sample_data.py     synthetic account generator
  export_static.py   bakes everything into one HTML file
  static/            frontend (no build step, no dependencies)
docs/                GitHub Pages (published build)
```

Python 3.11+. Three dependencies: `PyJWT`, `cryptography`, `requests`.

## License

MIT
