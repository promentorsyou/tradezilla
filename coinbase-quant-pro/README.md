# Coinbase Quant Pro

**2026-10-10 upgrade:** The existing TradeZilla Quant page now includes a
cost-aware scanner, seven timeframes, exact-market liquidity snapshots, a
Decimal profit solver, risk limits, hypothetical overlays, a rule-observation
journal and real offline ML/backtest reports. See [the upgrade audit and
verification record](docs/UPGRADE.md) for current capabilities and limitations.
The original beta description below is historical; no model is approved for
execution and no live inference backend has been deployed.

A running **local research beta**, not completion of the entire six-phase brief.
Public Coinbase Advanced spot data only. No private credentials, account access,
brokerage orders, leverage, margin, or automatic trading. The existing TradeZilla
portfolio pages and five-minute schedule are preserved. At the user's follow-up
request, TradeZilla now has an additional `#/quant` public research page. Its
public candle snapshot is refreshed by the same GitHub workflow; the full Python
backend described below is still local-only.

## Start locally (verified native path)

Prerequisites: Node 24, npm, `uv`, Python 3.12 or 3.13.

```sh
cd coinbase-quant-pro
python3 scripts/dev.py
```

- Website: http://127.0.0.1:3000/dashboard
- API documentation: http://127.0.0.1:8000/docs
- Stop: Ctrl-C. Both services bind only to loopback.

The launcher installs locked dependencies when needed, runs the database
migration, and starts both servers. Alternatively, use separate terminals:

```sh
cd coinbase-quant-pro/services/api
uv sync --frozen
uv run alembic upgrade head
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```sh
cd coinbase-quant-pro/apps/web
npm ci
npm run dev
```

Production frontend: `npm run build`, then `npm run start` in `apps/web`.
Do not run development and production frontend servers on port 3000 together.

## Docker Compose (provided, not runtime-verified here)

Docker is absent from the development machine. The PostgreSQL containers and
Compose startup still require verification on a Docker-equipped machine.

Create a `.env` from `.env.example`, set a URL-safe `POSTGRES_PASSWORD`, then:

```sh
docker compose up --build
```

Compose supplies PostgreSQL 16, the API, and a production Next.js frontend.
Database ports are not exposed; application ports bind to localhost only.
Do not expose this research beta publicly without authentication, durable job
ownership, distributed rate limiting and a deployment security review.

## Environment

No variables or Coinbase secrets are required for native development.

| Variable | Default / purpose |
|---|---|
| `DATABASE_URL` | `sqlite:///quant.db`; PostgreSQL SQLAlchemy URL supported |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8000`; public API base, build-time setting |
| `POSTGRES_PASSWORD` | Required for Compose only; use a URL-safe value |

The launcher inherits shell environment variables; it does not load a root
`.env` automatically. Compose loads `.env`. Never add Coinbase credentials.

## Implemented

- Next.js App Router, strict TypeScript, React, Tailwind 4, shadcn-style button,
  TanStack Query, Zustand, Lucide, Recharts and Lightweight Charts 5.2.1.
- Seven routes: dashboard, per-product analysis, markets, backtesting, models,
  signals and settings. Desktop terminal and responsive mobile layout.
- Active spot-market discovery, searchable editable watchlist and ticker relay.
- Public WebSocket reconnect/backoff, connection-wide sequence-gap detection,
  heartbeats, stale-price detection and REST reconciliation after reconnect.
- Genuine candles, crosshair, pan/zoom, volume, 1H/4H/1D/1W, four-chart mode,
  EMA/SMA/VWAP/Bollinger toggles, support/resistance bands, RSI and MACD panes.
- Chunked historical requests capped at 350 buckets; UTC weekly aggregation,
  validation, deduplication, gap detection and incomplete-candle labels.
- Python EMA 9/20/50/100/200, SMA 20/50/200, Wilder RSI/ATR/ADX, MACD,
  stochastic/Stoch RSI, CCI, ROC, Bollinger, Keltner, Donchian, historical
  volatility, OBV, CMF, MFI, relative volume, UTC-session bar-approximation VWAP
  and causal Ichimoku lines. Warmup values remain null.
- Confirmed pivot clusters with ATR-distance merging, volume-weighted centers,
  nearest three candidate zones each side and explicit descriptive scores.
- Completed-candle doji, hammer/star candidates, inside bar and engulfing shapes.
- Five-second REST order-book snapshots, bid/ask spread and depth imbalance.
- Decimal fee calculator including base/quote sizing and entry fee currency in
  the API. UI exposes quote-notional scenarios. These are hypothetical inputs.
- Three next-open long-only backtests: EMA crossover, RSI reversion and
  breakout-volume. Fees/slippage, position sizing, gap-through stops, stop-first
  ambiguous bars, equity, drawdown, trade history and net buy-and-hold comparison.
- Bounded asynchronous jobs; append-only application record writes for raw
  candle snapshots, analytical observations and completed backtests. SQLAlchemy
  and Alembic; SQLite verified locally, PostgreSQL driver supplied for Compose.

## Important methodology

Coinbase public USDC subscriptions can return the matching USD feed. The source
alias is displayed; it is not represented as a separate USDC order book.
REST prices in the watchlist are snapshots, not live-stream badges.

Indicators use **only completed bars in the most recent uninterrupted segment**.
Older gaps remain visible in data quality. On the observed XRP history, there is
a long gap before July 2023, so weekly EMA/SMA 200 are unavailable; no synthetic
bars fill that gap. Raw exchange responses are saved with analysis snapshots.

EMA uses a first-observation recursive seed and requires a full period before
display. Wilder indicators use an SMA seed. VWAP uses UTC-day-reset typical-price
times volume, not tick-level execution VWAP. Historical volatility is per-bar.
Ichimoku spans are shifted forward for causal displayed cloud values.

Zone strength is `min(40, touches*10) + 30*exp(-bars_since_pivot/100) +
min(30, average_pivot_volume / mean_volume * 15)`, rounded by component. It is
not a calibrated reversal probability. Zones are candidate clusters, not a full
break/retest lifecycle engine or authentic volume-at-price profile.

The primary decision is **WAIT** until a validated forecast and measured edge
exist. Evidence is descriptive. No arbitrary BUY/SELL confidence, fabricated
targets, or numeric forecast probabilities are emitted. A bearish trend is not
an instruction to open a short.

Backtests begin after a 200-bar warmup, decide from the preceding completed bar,
enter at the next open, charge fees and adverse slippage both ways, and choose
the stop when stop and target both occur in one OHLC bar. Position quantity uses
Decimal cash accounting. Full market fills are an assumption; limit fills,
partial fills and precise intrabar paths are not inferred. Tests are **in-sample
historical simulations**, not untouched holdout performance or validated edge.

## Explicitly incomplete

This is not a production-ready completion of all six phases. Remaining work:

1. Forecast training/calibration/registry artifacts, purged walk-forward tests,
   untouched holdout evaluation, probabilistic forecasts and model drift.
   XGBoost/LightGBM/PyTorch are not installed merely to imply trained models.
2. Full technical specification: Supertrend/divergence, advanced formations,
   structure/BOS/CHOCH, HTF zone confluence, period/Fibonacci pivots, confirmed
   break/retest invalidation and measured zone validation.
3. Structural trade plans, validated BUY/SELL gates, holding-aware exit analysis,
   maker/taker comparison UI, rebates, partial fills and tick-rounded sizing.
4. Additional strategies, start/end range selection, strategy comparison,
   out-of-sample backtesting, Sortino and independent execution-reference tests.
5. Reconstructed live L2/trade-flow history, scanner-wide technical computation,
   cooldown alerts, later signal outcomes and retention policies.
6. Normalized warehouse migrations for every table in the brief. Current schema
   is one append-only research-record table, not the complete warehouse. No
   database-level immutability enforcement; no separate ingestion worker.
7. Public deployment/authentication, distributed jobs/cache, Docker/PostgreSQL
   runtime verification and production hardening. No public site was deployed.

## Tests

```sh
cd services/api
uv run pytest -q
uv run ruff check app tests migrations
cd ../../apps/web
npm run test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
# With both local services running:
npm run e2e
```

Browser tests use real Coinbase data except explicitly named outage/staleness
tests, which intercept requests only inside Playwright. No production demo
dataset exists. See [verification](docs/VERIFICATION.md) for the final results.

## Structure

```text
coinbase-quant-pro/
  apps/web/{app,components,hooks,lib,tests}/
  services/api/app/{coinbase,indicators,structure,signals,risk,backtesting,database}/
  services/api/{migrations,tests}/
  scripts/dev.py
  docs/{IMPLEMENTATION.md,VERIFICATION.md,dashboard-desktop.png}/
  docker-compose.yml
  .env.example
```

Official connector/chart references are recorded in `docs/IMPLEMENTATION.md`.
The Sites skill influenced the local preview and visual QA workflow; the user's
explicit Next.js/FastAPI/local-startup architecture was retained, not converted
to a static or hosted Worker application.
