# Verification record — 2026-10-10

## Full local application

- Next.js 16.4.0 / React 19.3.0 production build: passed.
- Strict TypeScript and ESLint: passed.
- Backend pytest: 19 passed; one upstream Starlette/httpx deprecation warning.
- Ruff: passed. Alembic SQLite migration: revision `001`, head.
- Vitest 4.1.11: 2 passed.
- Playwright: 4 passed against the production frontend, including live ticker
  continuity, four timeframes, actual historical backtest, risk calculator,
  all routes, simulated stale feed, API failure and mobile overflow checks.
- Public Coinbase discovery returned 917 active spot products. All six requested
  default USDC pairs were available. Product count and prices change over time.
- Real XRP-USDC data arrived via the documented XRP-USD stream alias. A relay
  observation included 10 ticker events and 8 heartbeats without reconnect loops.
- XRP history: 499 completed 1H/4H/1D bars in the analysis request; weekly
  analysis used 168 contiguous completed bars after excluding older history
  across the exchange gap. Weekly EMA/SMA 200 remained null.
- Actual 700-bar XRP EMA simulation completed with 6 trades, including losses.
  This is historical in-sample execution testing, not validated profitability.
- Production npm dependencies: zero reported advisories. Full npm audit still
  reports five high-severity **development-toolchain** findings in the
  ESLint/fast-glob/micromatch/braces chain; no patched braces release was available
  in the registry. Dev tools are not exposed as a public service. Review before
  production hardening. The earlier vulnerable Vitest was replaced.
- A clean `npm ci` was verified. Lockfile generation used npm 11.21.0 to avoid
  an npm 11.5.1 peer-resolution crash; installing from the lock works with 11.5.1.
- Docker is not installed: Compose YAML parsed, but image builds, PostgreSQL
  migrations and container startup are **not runtime-verified**.

## TradeZilla extra page

The user confirmed Quant Pro belongs as an additional page in the existing
TradeZilla website. `#/quant` is a separate browser-based public research view;
it does not pretend the FastAPI backend is hosted on GitHub Pages.

- Six public products and 1H/4H/1D/1W histories are published as
  `docs/quant-data.json` by the existing five-minute GitHub workflow.
- Direct browser REST was tested and rejected by Coinbase's CORS policy. A
  public WebSocket supplies live ticker updates independently of scheduled data.
- The hosted view supports candlesticks, pan/zoom, volume, EMA20/50/200, RSI,
  pivot reaction zones, multi-timeframe table, live/stale/disconnected labels,
  and explicit not-trained/hosted-backend-required states.
- Four browser-analysis unit tests and one UTC-week aggregation test passed.
- Browser checks found no page errors, all four chart timeframes loaded, and
  mobile document width stayed within the viewport.
- The original embedded portfolio snapshot was preserved exactly by the UI
  rebuild. No accounting, trade matching, fee-tier, or portfolio-value logic changed.

Screenshots:
- `dashboard-desktop.png`: full local Next.js app.
- `dashboard-mobile-outage.png`: explicit test-only API outage.
- `tradezilla-quant-desktop.png`: additional TradeZilla page.
- `tradezilla-quant-mobile.png`: mobile page layout.

See README's incomplete-feature list. No trained models, calibrated forecasts,
production security certification or Docker success is claimed.
