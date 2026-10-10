import numpy as np
import pytest
from app.backtesting.engine import barrier_outcome, summarize_outcomes
from app.signals.research import features, splits, predict_metrics, context_bars
from app.signals.decision_engine import candidates
from app.risk.trade_planner import RiskInput, calculate


def candles(n=300):
    return [
        dict(
            time=1704067200 + i * 300,
            open=100 + i * 0.01,
            high=101 + i * 0.01,
            low=99 + i * 0.01,
            close=100 + i * 0.01,
            volume=10 + i % 9,
        )
        for i in range(n)
    ]


def test_fee_examples_backend():
    for fee, profit in [(0, 714.285714), (0.075, 638.2712965)]:
        r = calculate(
            RiskInput(
                amount=50000,
                entry=1.4,
                exit=1.42,
                stop=1.38,
                entry_fee_pct=fee,
                exit_fee_pct=fee,
                slippage_pct=0,
                spread_pct=0,
            )
        )
        assert float(r["net_profit"]) == pytest.approx(profit, abs=0.0001)
        assert float(r["total_cost_basis"]) <= 50000


def test_stop_first_and_gap_censoring():
    rows = candles(3)
    r = barrier_outcome(rows, 100, 99.5, 100.5, 3, fee=0, slip=0)
    assert r["label"] == 0 and r["net_return"] == pytest.approx(-0.005)
    assert barrier_outcome(rows[::2], 100, 98, 102, 2) is None
    assert barrier_outcome(rows, 100, 98, 102, 4) is None


def test_timeout_and_no_double_costs():
    r = barrier_outcome(candles(3), 100, 90, 120, 3, fee=0.001, slip=0.0005)
    assert r["label"] == 1
    assert r["net_return"] == pytest.approx(100.02 * 0.9995 * 0.999 / (100 * 1.0005 * 1.001) - 1)


def test_feature_causality():
    a, _ = features(candles(250))
    b, _ = features(candles(300))
    np.testing.assert_allclose(a, b[:250], equal_nan=True)


def test_purge_and_disjoint_calibration():
    s = splits(8000, 288)
    assert s["train"][1] + 288 == s["select"][0]
    assert s["select"][1] + 288 == s["calibrate"][0]
    assert s["calibrate"][1] + 288 == s["test"][0]


def test_probability_validation_and_metrics():
    p = np.array([[0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]])
    assert predict_metrics(np.array([0, 1, 2]), p)["brier"] == pytest.approx(0.06)
    with pytest.raises(ValueError):
        predict_metrics(np.array([0, 1, 2]), p * 2)


def test_no_invented_context_or_setup_history():
    assert candidates(candles(20)) == []
    assert len(context_bars(candles(13), 3600)) == 1
    rows = candles(300)
    rows.pop(-20)
    assert candidates(rows) == []  # latest gap leaves insufficient contiguous history
    assert summarize_outcomes([])["expectancy"] is None


@pytest.mark.parametrize("coin", ["XRP", "BTC", "ETH", "SOL", "ADA", "ZEC"])
def test_candidate_schema_never_claims_calibrated_buy(coin):
    for c in candidates(candles()):
        assert c["state"] in ("WATCH", "ARMED", "TRIGGERED", "INVALIDATED")
        assert c["stop"] < c["entry"]
        assert c["timestamp"] == candles()[-1]["time"] + 300
        assert "Unvalidated" in c["validation"]
