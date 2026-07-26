"""Generate a synthetic account so the demo build contains no real trading data.

    python sample_data.py > sample_report.json

Produces the same report structure `engine.build_report()` returns, from
invented fills. Nothing here touches Coinbase and no personal data is involved,
so the output is safe to commit and publish.

The generated account is deliberately ordinary: a mix of winners and losers, a
drawdown, some open positions, a realistic fee drag.
"""
from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timedelta, timezone

import engine
from events import merged_events

SYMBOLS = [
    # symbol, start price, annual drift, daily vol
    ("BTC", 61000.0, 0.10, 0.022),
    ("ETH", 3100.0, 0.05, 0.030),
    ("SOL", 148.0, -0.15, 0.045),
    ("ADA", 0.62, -0.25, 0.040),
    ("LINK", 17.5, 0.02, 0.038),
    ("XRP", 0.58, -0.05, 0.035),
]
MAKER, TAKER = 0.004, 0.008


def walk(start: float, days: int, drift: float, vol: float, rng) -> list[float]:
    px, out = start, []
    for _ in range(days):
        px *= 1 + rng.gauss(drift / 365, vol)
        out.append(max(px, 1e-6))
    return out


# Anchored to a fixed date, not "now", so the sample is byte-for-byte
# reproducible. Anchoring to the clock silently reshuffles trades across day
# boundaries on every build - win/loss day counts drift - which makes it
# impossible to tell a real change from a rebuild.
ANCHOR = datetime(2026, 7, 1, tzinfo=timezone.utc)


def build_sample(seed: int = 7) -> dict:
    rng = random.Random(seed)
    days = 260
    t0 = ANCHOR - timedelta(days=days)
    paths = {s: walk(p, days, d, v, rng) for s, p, d, v in SYMBOLS}

    fills: list[dict] = []
    tid = 0

    def add(symbol, day, side, qty, price, maker):
        nonlocal tid
        tid += 1
        ts = (t0 + timedelta(days=day, hours=rng.randint(0, 23),
                             minutes=rng.randint(0, 59)))
        rate = MAKER if maker else TAKER
        fills.append({
            "trade_id": str(tid), "order_id": f"o{tid}",
            "trade_time": ts.isoformat().replace("+00:00", "Z"),
            "product_id": f"{symbol}-USD", "side": side,
            "price": f"{price:.8f}", "size": f"{qty:.8f}",
            "size_in_quote": False,
            "commission": f"{qty * price * rate:.8f}",
            "liquidity_indicator": "MAKER" if maker else "TAKER",
        })

    # ~45 round trips plus a few positions left open
    for symbol, *_ in SYMBOLS:
        path = paths[symbol]
        day = rng.randint(3, 25)
        while day < days - 12:
            entry = path[day]
            size_usd = rng.choice([250, 400, 600, 900, 1400])
            qty = size_usd / entry
            maker_in = rng.random() < 0.55
            add(symbol, day, "BUY", qty, entry, maker_in)

            hold = rng.randint(2, 26)
            exit_day = min(day + hold, days - 1)
            exit_px = path[exit_day]
            # a stop-style exit is a taker; a target exit rests as a maker
            won = exit_px > entry
            add(symbol, exit_day, "SELL", qty, exit_px, maker=won and rng.random() < 0.7)
            day = exit_day + rng.randint(4, 30)

        # leave one position open near the end
        if rng.random() < 0.6:
            d = days - rng.randint(2, 9)
            qty = rng.choice([300, 500, 800]) / path[d]
            add(symbol, d, "BUY", qty, path[d], rng.random() < 0.5)

    fills.sort(key=lambda f: f["trade_time"], reverse=True)

    events = merged_events(fills, {})
    trades = engine.build_trades(events)
    prices = {s: paths[s][-1] for s, *_ in SYMBOLS}
    prices.update({"USD": 1.0, "USDC": 1.0})
    engine.mark_open_trades(trades, prices)
    daily = engine.daily_stats(trades)

    # synthetic balances consistent with the open positions
    accounts = []
    for t in trades:
        if t["status"] == "OPEN" and t["open_qty"] > 0:
            accounts.append({
                "currency": t["symbol"],
                "available_balance": {"value": f"{t['open_qty']:.8f}"},
                "hold": {"value": "0"},
            })
    accounts.append({"currency": "USDC",
                     "available_balance": {"value": "1850.00"}, "hold": {"value": "0"}})

    pf = engine.portfolio(accounts, prices)
    s = engine.summary(trades, daily)
    flows = {"deposits": 25000.0, "withdrawals": 0.0, "clawbacks": 0.0,
             "external_buys": 0.0, "net_invested": 25000.0}
    rewards = {"by_type": {"staking_reward": 42.10, "interest": 18.65}, "total": 60.75}
    # make the synthetic portfolio agree with its own P&L
    flows["net_invested"] = round(
        pf["total_value"] - s["total_realized"] - s["unrealized_pnl"] - rewards["total"], 2
    )

    return {
        "generated_at": ANCHOR.isoformat(timespec="seconds"),
        "summary": s,
        "reconciliation": engine.reconcile(s, pf, flows, rewards),
        "trades": trades,
        "days": daily,
        "drawdown": engine.drawdown_series(daily),
        "by_symbol": engine.by_symbol(trades),
        "hourly": engine.hourly_performance(trades),
        "weekday": engine.weekday_performance(trades),
        "portfolio": pf,
        "fee_tier": {"tier": "Sample", "maker": MAKER, "taker": TAKER,
                     "volume_30d": 18400.0, "total_fees": s["total_fees"]},
        "open_orders": [],
        "cash_flows": flows,
        "rewards": rewards,
        "event_count": len(events),
        "prices": prices,
        "is_sample": True,
    }


if __name__ == "__main__":
    json.dump(build_sample(), sys.stdout, default=str)
