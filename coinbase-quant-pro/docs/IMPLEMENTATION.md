# Implementation checklist

This is a separate local application. It does not replace TradeZilla, use its
private Coinbase credentials, or change its GitHub Actions scheduler.

1. Public Coinbase connector, validated paginated candles, live ticker relay.
2. Next.js terminal, market discovery, four timeframes, genuine interactive charts.
3. Completed-candle technical analysis and confirmed pivot zones.
4. Decimal hypothetical cost calculator and conservative historical backtests.
5. Tests, production build, browser verification, screenshots and delivery notes.
6. Later: calibrated model lifecycle, advanced patterns, full order-flow history.

Architecture: Next.js App Router + FastAPI modular monolith; SQLAlchemy records
and Alembic migrations; PostgreSQL in Compose, SQLite for native development.
No Redis until distributed workers are justified. Backtests use a bounded local
background executor (single API worker). Production multi-worker jobs and public
authentication are not supplied. No brokerage/account/order endpoints exist.

Official references consulted during implementation:
- https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api
- https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview
- https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints
- https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles
- https://github.com/coinbase/coinbase-advanced-py
- https://tradingview.github.io/lightweight-charts/docs

Use direct HTTPX for public GET-only endpoints; no authenticated SDK/client.
Coinbase USDC aliases may stream under USD products; display the source mapping.
Do not interpret an exchange alias as an independent USDC order book.
