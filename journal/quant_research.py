"""Public-only periodic research worker. No keys, account balances or user inputs.

Run with the existing API's locked environment, independently of the five-minute
portfolio refresh. Publication is atomic; failed research leaves the old report.
"""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from quant_market import PRODUCTS, candles, get
from app.signals.research import evaluate, setup_tests
from app.backtesting.engine import BacktestInput, run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bars", type=int, default=8000)
    args = parser.parse_args()
    if not 2000 <= args.bars <= 30000:
        raise SystemExit("Use 2000–30000 five-minute bars")
    now = int(get("/time")["epochSeconds"])
    results = []
    for product in PRODUCTS:
        print("Public research: " + product, flush=True)
        rows = candles(product, "FIVE_MINUTE", 300, args.bars, now)
        result = evaluate(
            rows, product, Path(__file__).resolve().parent / "dist/quant-models"
        )
        result["rule_backtests"] = setup_tests(rows)
        result["existing_engine_benchmarks"] = {
            s: run(
                [{**r, "complete": True} for r in rows],
                BacktestInput(
                    product=product,
                    timeframe="5m",
                    strategy=s,
                    fee_pct=0.1,
                    slippage_pct=0.05,
                ),
            )["metrics"]
            for s in ("ema", "rsi", "breakout")
        }
        result["benchmark_scope"] = (
            "Existing engine in-sample, full-fill simulations; not model validation"
        )
        results.append(result)
    destination = Path(__file__).resolve().parent.parent / "docs/quant-research.json"
    old = json.loads(destination.read_text()) if destination.exists() else {}
    version = hashlib.sha256(("rules-1:" + str(now)).encode()).hexdigest()[:12]
    stamp = datetime.now(timezone.utc).isoformat()
    registry = old.get("registry", []) + [
        {
            "version": version,
            "trained_at": stamp,
            "data_end": now,
            "validated": False,
            "coins": PRODUCTS,
        }
    ]
    result = {
        "version": version,
        "generated_at": stamp,
        "mode": "scheduled research; no live inference server",
        "products": results,
        "registry": registry,
        "signal_journal": old.get("signal_journal", []),
        "signal_status": "No qualified recommendations generated. Empty journal is not a winning track record.",
        "cost_assumptions": {
            "taker_pct_per_leg": 0.1,
            "slippage_pct_per_leg": 0.05,
            "historical_book": "unavailable",
            "maker_fill_probability": None,
        },
        "scope": "Research probabilities are not published as actionable predictions. No validated setup expectancy for custom budgets/costs.",
    }
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    temporary.replace(destination)
    print("Published research snapshot " + version, flush=True)


if __name__ == "__main__":
    main()
