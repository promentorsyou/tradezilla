import asyncio
from decimal import Decimal

import httpx
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.backtesting.engine import BacktestInput, run
from app.coinbase.client import Coinbase, DataError, validate_candles, weekly
from app.indicators.core import calculate, wilder
from app.main import app
from app.risk.trade_planner import RiskInput, calculate as cost
from app.signals.decision_engine import decide
from app.structure.support_resistance import detect


def fixture(n=300):
    # Synthetic financial data is confined to deterministic test fixtures.
    return [
        {
            "time": 1704067200 + i * 3600,
            "open": 100 + i * 0.1,
            "close": 100 + i * 0.1,
            "high": 101 + i * 0.1,
            "low": 99 + i * 0.1,
            "volume": 10,
            "complete": True,
        }
        for i in range(n)
    ]


def test_validation_and_dedup():
    raw = [dict(start=0, open=10, high=11, low=9, close=10, volume=1)] * 2
    candles, gaps = validate_candles(raw, 3600, 7200)
    assert len(candles) == 1 and not gaps and candles[0]["complete"]


@pytest.mark.parametrize(
    "field,value", [("high", 8), ("volume", -1), ("close", "nan"), ("low", 12)]
)
def test_invalid_candles(field, value):
    raw = dict(start=0, open=10, high=11, low=9, close=10, volume=1)
    raw[field] = value
    with pytest.raises(DataError):
        validate_candles([raw], 3600, 7200)


def test_weekly_utc_and_missing_day():
    daily = [{**r, "time": 1704067200 + i * 86400} for i, r in enumerate(fixture(14))]
    result = weekly(daily, 1704067200 + 14 * 86400)
    assert len(result) == 2 and all(c["complete"] for c in result)
    assert result[0]["volume"] == 70 and result[0]["open"] == 100
    assert len(weekly(daily[1:], 1704067200 + 14 * 86400)) == 1


def test_indicators_against_closed_form():
    rows = fixture()
    result = calculate(rows)
    assert result.rsi.iloc[-1] == 100
    assert result.atr.iloc[-1] == pytest.approx(2)
    assert result.sma20.iloc[-1] == pytest.approx(np.mean([r["close"] for r in rows[-20:]]))
    expected = rows[0]["close"]
    for row in rows[1:]:
        expected = (2 / 21) * row["close"] + (19 / 21) * expected
    assert result.ema20.iloc[-1] == pytest.approx(expected)
    assert result.bb_upper.iloc[-1] == pytest.approx(
        np.mean([r["close"] for r in rows[-20:]]) + 2 * np.std([r["close"] for r in rows[-20:]])
    )
    assert result.macd_hist.iloc[-1] == pytest.approx(
        result.macd.iloc[-1] - result.macd_signal.iloc[-1]
    )


def test_wilder_known_seed():
    out = wilder(pd.Series([1.0, 2.0, 3.0, 4.0]), 3)
    assert np.isnan(out.iloc[1]) and out.iloc[2] == 2
    assert out.iloc[3] == pytest.approx(8 / 3)


def test_indicators_do_not_repaint():
    rows = fixture()
    a, b = calculate(rows[:220]), calculate(rows)
    pd.testing.assert_frame_equal(a, b.iloc[:220])


def test_warmup_not_fabricated():
    result = calculate(fixture(40))
    assert result.ema200.isna().all()
    assert result.rsi.iloc[:14].isna().all()


def test_risk_fee_accounting():
    result = cost(
        RiskInput(
            entry=100,
            exit=110,
            stop=95,
            amount=1000,
            entry_fee_pct=1,
            exit_fee_pct=1,
            slippage_pct=0,
            spread_pct=0,
        )
    )
    assert Decimal(result["total_cost_basis"]) == 1010
    assert Decimal(result["net_profit"]) == 79
    assert Decimal(result["break_even"]) == Decimal(1010) / Decimal("9.9")


def test_base_currency_fee():
    result = cost(
        RiskInput(
            entry=100,
            exit=110,
            stop=95,
            amount=10,
            size_unit="base",
            fee_currency="base",
            entry_fee_pct=1,
            exit_fee_pct=0,
            slippage_pct=0,
            spread_pct=0,
        )
    )
    assert Decimal(result["quantity_acquired"]) == Decimal("9.9")
    assert Decimal(result["net_profit"]) == 89


def test_confirmation_requires_right_candles():
    rows = fixture(20)
    rows[-1]["high"] = 1000
    assert not any(z["upper"] > 500 for z in detect(rows))


def test_wait_without_model():
    result = decide("STALE", {}, [])
    assert result["state"] == "WAIT" and result["probability"] is None and result["plan"] is None


def test_backtest_no_trades_is_honest():
    result = run(fixture(), BacktestInput(fee_pct=0, slippage_pct=0))
    assert result["metrics"]["trade_count"] == 0
    assert result["metrics"]["net_pnl"] == 0


def test_ambiguous_stop_and_next_bar(monkeypatch):
    rows = fixture(205)
    ind = calculate(rows)
    ind["ema20"], ind["ema50"] = 0.0, 1.0
    ind.loc[199:, "ema20"] = 2.0
    rows[200].update(open=100, high=110, low=90, close=100)
    monkeypatch.setattr("app.backtesting.engine.calculate", lambda _: ind)
    result = run(rows, BacktestInput(fee_pct=0, slippage_pct=0))
    trade = result["trades"][0]
    assert trade["entry_time"] == rows[200]["time"]
    assert trade["exit"] == 98 and trade["net_pnl"] < 0
    assert result["metrics"]["net_pnl"] == pytest.approx(
        sum(t["net_pnl"] for t in result["trades"])
    )


async def test_rate_limit_retry(monkeypatch):
    attempts = []

    def transport(request):
        attempts.append(request)
        return httpx.Response(429 if len(attempts) == 1 else 200, json={"ok": True})

    client = Coinbase()
    await client.http.aclose()
    client.http = httpx.AsyncClient(
        transport=httpx.MockTransport(transport), base_url="https://api.coinbase.com"
    )
    original = asyncio.sleep

    async def fast(_):
        await original(0)

    monkeypatch.setattr(asyncio, "sleep", fast)
    assert await client.get("/market/products") == {"ok": True}
    assert len(attempts) == 2
    await client.http.aclose()


def test_no_brokerage_endpoints():
    paths = [getattr(r, "path", "") for r in app.routes]
    assert not any("orders" in p or "accounts" in p or "transfer" in p for p in paths)
    with TestClient(app) as client:
        assert client.get("/api/v1/health").json()["mode"] == "public-read-only"
        assert (
            client.post(
                "/api/v1/risk/calculate", json={"entry": 100, "exit": 120, "stop": 101}
            ).status_code
            == 422
        )
        assert client.get("/api/v1/forecasts/XRP-USDC").json()["probabilities"] is None
