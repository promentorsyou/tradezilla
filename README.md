# TradeZilla

A trading journal for Coinbase. Reconstructs round-trip trades from your
account activity and renders a dashboard, day view, trade log, positions,
reports and a P&L calendar.

**[▶ Live demo](https://promentorsyou.github.io/tradezilla/)** — generated
sample data, no real account involved.

![Dashboard](docs/screenshot-dashboard.png)

---

## Security

This repository contains **no credentials and no personal financial data**, and
it never should.

- The API client (`journal/cb_client.py`) exposes **HTTP GET only**. It cannot
  place, modify or cancel an order even if you asked it to.
- Use a **View-only** Coinbase API key. Nothing here needs trade permission.
- Credentials are read from **environment variables**. There is no config file
  to accidentally commit.
- The published demo runs on **generated sample data** (`journal/sample_data.py`),
  not on anyone's real account.
- `.gitignore` blocks the cache of raw fills, and any static build containing
  real balances, from ever being committed.

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
- Matching is **FIFO**, tracked **per asset** — `BTC-USD` and `BTC-USDC` are the
  same coins in the same wallet.
- `net_pnl = exit proceeds − FIFO cost of units sold − commissions`, using
  Coinbase's real per-fill commission rather than an assumed fee tier.

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
| `dist/index.html` | your real balances | **No** |
| `dist/demo.html` | same trades, all dollar amounts rescaled by one constant | your call |
| `dist/sample.html` | invented data | yes |

`--demo` multiplies every dollar figure by a single factor, so win rate, profit
factor, ratios and history stay exactly true while balances aren't disclosed.

`docs/` is served by GitHub Pages and holds the **sample** build.

---

## Layout

```
journal/
  cb_client.py       read-only Coinbase client (GET only, env-var creds)
  events.py          merges Advanced fills + v2 ledger into one event stream
  engine.py          FIFO trade building, analytics, reconciliation
  server.py          stdlib HTTP server + JSON API
  sample_data.py     synthetic account generator
  export_static.py   bakes everything into one HTML file
  static/            frontend (no build step, no dependencies)
docs/                GitHub Pages (sample build)
```

Python 3.11+. Three dependencies: `PyJWT`, `cryptography`, `requests`.

## License

MIT
