# Quant Pro opportunity research upgrade — 2026-10-10

## Scope and completion boundary

Implemented in the existing TradeZilla `#/quant` page. This is **scheduled
research and hypothetical planning**, not a production real-time ML trading
system. All actionable scanner outputs remain WAIT. No order, transfer, private
account or credential entry capability was added.

## Audit before implementation

| Existing component | Verified finding | Action |
|---|---|---|
| Public ticker | All six USDC products advertise USD aliases; Coinbase documents public USDC feeds as matching USD feeds | Retained; explicitly label live ticker/L2 as USD proxy |
| Exact USDC REST market | All six metadata responses report USDC and online spot status; all six books echo exact USDC product ID | Validate IDs/status/quote, expose book timestamp and price/quantity increments |
| Candlestick chart | `draw()` destroyed/recreated the chart and reset range | Retain chart/primary series, preserve visible time range for same market/frame |
| Support/resistance | Existing confirmed-pivot algorithm; descriptive scores, not probabilities | Reused; shared Python detector drives rule candidates |
| Historical candles | Four frames; XRP weekly contiguous history below 200 | Add real REST 1m/5m/15m, keep warmup unavailable across gaps, per-frame coverage |
| Public independence | `render()` and `wire()` depended on private report `DATA.days` | Quant route bypasses portfolio rendering/wiring; tested null portfolio |
| Backtesting | Existing next-open, stop-first Python engine | Reuse benchmark strategies; extend same module for barrier and setup evaluation |
| Risk calculator | Existing Python quote sizing added buy fees beyond the stated budget | Include buy fee within total quote budget; deterministic regression tests |
| Scanner/solver | Absent from published page | Added strict gates, comparisons, Decimal arithmetic, risk sizing and chart levels |
| Models | No trained or validated hosted models | Added offline fitted benchmarks, purged chronological evaluation and honest nonvalidated registry |

Initial published views: six markets × four frames, no page errors. XRP had 168
contiguous weekly bars, the other five had 213; these are dated observations,
not hard-coded expectations. Before screenshot: `upgrade-before.png`.

## Architecture and source of truth

- `journal/static/{index.html,app.js,app.css,quant-pro.js,quant-planner.js,quant-workbench.js}`
  are the UI sources. `journal/export_static.py` inlines them into the single
  `docs/index.html` served by GitHub Pages. `journal/rebuild_ui.py` preserves the
  existing embedded portfolio report exactly.
- `journal/quant_market.py` fetches public Coinbase metadata, exact requested
  USDC books and completed candles. The existing five-minute GitHub refresh
  publishes `docs/quant-data.json`. GitHub can delay runs; snapshots are not
  execution-grade 1m or 5m trading infrastructure.
- Public ticker/Level 2 runs directly in the browser against Coinbase. Sequence
  gaps invalidate the book and reconnect. Completed candle indicators never
  consume these ticks. Currently forming candles remain explicitly unavailable.
- `journal/quant_research.py` uses the existing Python research environment and
  publishes `docs/quant-research.json`. `.github/workflows/quant-research.yml`
  trains daily at 03:23 UTC, separately from the five-minute refresh. It has no
  Coinbase account secrets. Fitted research artifacts are retained as GitHub
  Actions artifacts for 30 days, not served as an inference API.
- `journal/quant_journal.py` records immutable public rule observations, with
  separately appended hypothetical outcome events. It never records browser
  budget/settings. Latest 100 observations are exposed; earlier snapshots are
  archived in Git. These are WAIT observations, **not filled paper trades**.
- Existing FastAPI `/api/v1/research/report` exposes a generated local report
  when available. Existing API candle/analysis/backtest endpoints now accept
  short-term frames. No externally hosted API was purchased or provisioned.

## Market mapping and freshness

XRP, BTC, ETH, SOL, ADA and ZEC have `-USDC` REST products and books, and `-USD`
public stream aliases. The exact execution book is requested with the USDC ID
and must echo it. Candle requests use USDC IDs. The public stream returns the
documented USD alias. Neither account settlement eligibility nor conversion
basis is established by public metadata, so `basis_verified=false` blocks
executable recommendations. No blanket USD=USDC conversion is assumed.

Exact REST book observations are labeled stale for execution after 15 seconds;
live USD-proxy depth is separately labeled. Bid/ask, spread, visible quote depth,
buy VWAP, exit sweep VWAP, imbalance and observable impact are size-aware. Depth
is not a fill guarantee or prediction of future liquidity. Missing/gapped bars
are never interpolated. Weekly bars require seven complete Monday-UTC days.

Official references:

- [Coinbase public stream aliases and channels](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints)
- [Exact public product book](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-book)
- [Public candle granularities and limits](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles)

## Planning assumptions

Decimal.js-light 2.5.1 is vendored with its license. Python uses Decimal.
Quote-fee budget formula: `quantity = budget / (entry * (1 + buy_fee))`, then
round quantity down to the base increment. Entry/required exits round up to the
price tick. The target solver works against actual modeled deployed cost, not
unspent partial-fill cash. Entry and exit fees are charged once each.

Optional base-fee scenario deducts the entry fee from acquired inventory and
reserves extra base for the sell fee; it is explicitly hypothetical, not a claim
about an actual fill's fee currency. Slippage is adverse on each leg. Optional
spread is half per leg for mid-price inputs; use zero for ask/limit inputs to
avoid double counting. Maker and taker fees are editable assumptions—not the
user's verified Coinbase tier. Partial fills and unavailable depth are explicit.

50,000 budget, 1.40 entry, 1.42 exit, no extra slippage:

- Zero fees: approximately 714.285714 net.
- 0.075% per leg, entry fee inside budget: approximately 638.2712965 net.

Risk-limited capital is capped by budget, per-opportunity capital, remaining
exposure, maximum risk, remaining daily loss and concurrent-signal limits.
Stops are hypothetical execution levels, not guaranteed loss caps.

## Research methodology and measured results

First run used up to 8,000 real five-minute bars per coin (approximately 28 days),
not synthetic training data. Three models: logistic regression, Random Forest
and LightGBM. No-change and training-class-frequency baselines are included.
Feature columns and model version are in the report. No historical order book,
trade imbalance, or spread features were invented.

Generic supervised benchmark: next-open entry, ATR stop and 2×ATR target,
stop-first ambiguous bars, timeout; 0.1% taker fee and 0.05% slippage **per leg**.
This is not the probability of a particular custom target or entry-rule setup.
Chronological train/select/calibration/test partitions purge overlapping label
horizons. Selection never uses test results. Separate sigmoid calibration,
three forward logistic blocks, multiclass Brier/log loss, precision/recall,
calibration bins and regime breakdowns are stored.

First report `2ccda73ddd0a` fitted 42 model/horizon combinations. Some longer
horizons were withheld because the purged partitions lacked all three outcome
classes. Selected-model held-out Brier scores at 15 minutes versus the class
prior baseline (lower is better):

| Coin | Selected model | Brier | Baseline |
|---|---|---:|---:|
| XRP | Random Forest | 0.5477 | 0.5453 |
| BTC | Random Forest | 0.5489 | 0.5469 |
| ETH | Random Forest | 0.5367 | 0.5390 |
| SOL | Random Forest | 0.5270 | 0.5277 |
| ADA | Random Forest | 0.5553 | 0.5571 |
| ZEC | Random Forest | 0.5431 | 0.5403 |

These results do not demonstrate a stable validated trading edge. None of the
observed rules-only setup/horizon cells had positive net expectancy under these
cost assumptions. Small/empty samples remain unqualified. The UI displays the
actual report, including loss-making results, rather than inventing confidence.

Four explicit rules share the same candidate generator in snapshots and held-out
setup tests: support rejection, breakout/retest, trend pullback and range trading.
Rules are exploratory, with WATCH/ARMED/TRIGGERED and expired/invalidated states.
TRIGGERED is not BUY. Daily held-out periods overlap earlier research runs and
must not be presented as independent new validation. No frozen production model
has passed the required longer independent regimes and execution-quality tests.

## Verification and operations

Run from repository root:

```sh
python3 journal/quant_market.py
python3 journal/rebuild_ui.py
node --test journal/test_quant_public.cjs journal/test_quant_planner.cjs
python3 journal/test_quant_market.py
uv run --project coinbase-quant-pro/services/api --frozen pytest coinbase-quant-pro/services/api/tests
node --test journal/test_quant_ui.cjs
uv run --with playwright==1.55.0 python journal/verify_site.py --local
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs
```

Open `http://127.0.0.1:8765/#/quant`. The browser test uses the existing web
workspace's Playwright install (`npm ci` there if dependencies are absent).
For offline training:

```sh
uv run --project coinbase-quant-pro/services/api --frozen python journal/quant_research.py --bars 8000
```

macOS LightGBM needs `brew install libomp`. Installed locally during verification;
Homebrew also automatically removed old downloadable package caches, not project
data. Docker image has a libgomp dependency but Docker runtime remains unverified.

Publish by committing source and generated public `docs/` artifacts and pushing
main. Existing Pages workflow deploys docs; the portfolio refresh subsequently
updates all pages plus public market data. Dispatch the new research workflow
for an immediate cloud training pass. Never stage DBs, credentials or user inputs.

Local verification: 32 Python API tests, 14 browser-math/indicator tests, four
public-market/journal tests, eight route checks, and a Playwright UI suite testing
six coins × seven frames, retained chart identity, solver, inputs, sorting,
overlays, keyboard, mobile overflow, missing portfolio and failed snapshots.
Live ticker plus L2 continuity test: one socket over 15 seconds, no page errors.
All six public markets separately reached LIVE for ticker and USD-proxy L2.
The browser suite also injects a WebSocket sequence gap and verifies reconnect.
Screenshots: `upgrade-desktop.png`, `upgrade-mobile.png` (before/after retained).

### Verified cloud deployment

- Initial upgrade commit: `a97f6fd`; Pages deployment `38066708669` passed.
- Five-minute refresh run `38066725379` passed public fetching, private portfolio
  validation, publication, all three public-file hashes and all eight routes.
- Daily research run `38066760277` passed in GitHub: tests, six-market training,
  research-artifact upload, prepublication checks, deploy, hashes and eight live
  routes. It completed in 2m57s. Research commit: `60a53d8`.
- Training cadence: daily 03:23 UTC; market/portfolio cadence: existing five-minute
  cron. Neither cadence guarantees punctual execution. No laptop is required.
- All account/trading paths remain unchanged; new workers and stream processing
  are public/read-only. Final minor hardening also enforces exchange minimum
  sizes and reports limit-only/post-only restrictions.

## Honest remaining limitations

- No hosted execution-grade inference service or verified live USDC settlement
  basis; no qualified BUY/SELL or risk-adjusted expectancy ranking is enabled.
- Approximately one month of OHLCV is insufficient production regime coverage.
  No validated custom-target probability, maker fill model, historical L2 replay,
  transaction-level barrier ordering or calibrated candidate expectancy exists.
- The fitted models are generic barrier benchmarks, not validated probabilities
  for the four entry rules. Several long horizons lack sufficient classes.
- No live/paper-trade fills or realized portfolio P/L are claimed. Journal paths
  are hypothetical; unresolved missing data stays unresolved.
- Forecast fan overlays remain unavailable. Shown chart levels are explicitly
  hypothetical/unvalidated; the existing historical candles are not forecasts.
- No claim that scheduled snapshots support sub-minute execution or that a
  net target will be achieved. The larger six-phase production mission remains
  incomplete until data/validation/hosting requirements genuinely pass.
