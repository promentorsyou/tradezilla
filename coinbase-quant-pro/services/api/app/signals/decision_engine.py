from app.structure.support_resistance import detect


def candidates(candles, hourly=None, four_hour=None):
    """Causal rule candidates, not recommendations. Shared by snapshots and backtests."""
    rows = candles[:]
    for i in range(1, len(rows)):
        if rows[i]["time"] - rows[i - 1]["time"] != 300:
            rows = rows[i:]
            return candidates(rows, hourly, four_hour)
    if len(rows) < 60:
        return []
    last, prev = rows[-1], rows[-2]
    atr = (
        sum(
            max(b["high"] - b["low"], abs(b["high"] - a["close"]), abs(b["low"] - a["close"]))
            for a, b in zip(rows[-15:-1], rows[-14:])
        )
        / 14
    )
    if atr <= 0:
        return []
    zones = detect(rows[:-1], atr)
    support = next((z for z in zones if z["type"] == "support"), None)
    resistance = next((z for z in zones if z["type"] == "resistance"), None)
    rv = last["volume"] / max(sum(r["volume"] for r in rows[-21:-1]) / 20, 1e-12)

    def ema(rs, period):
        value = rs[0]["close"]
        for r in rs[1:]:
            value += (r["close"] - value) * 2 / (period + 1)
        return value

    # Only completed context bars supplied by callers are allowed.
    bullish = all(rs and len(rs) >= 50 and ema(rs, 20) > ema(rs, 50) for rs in (hourly, four_hour))
    mean20 = ema(rows, 20)
    quiet = abs(ema(rows, 20) - ema(rows, 50)) < atr * 0.5
    specs = []
    if support:
        near = last["low"] <= support["upper"] + atr * 0.25
        confirmed = (
            near and last["close"] > support["upper"] and last["close"] > last["open"] and rv >= 1.2
        )
        specs.append(
            (
                "Support rejection",
                support["upper"],
                support["lower"] - atr * 0.25,
                confirmed,
                near,
                "5m bullish close above support with relative volume ≥ 1.2",
            )
        )
    prior_ceiling = max(r["high"] for r in rows[-22:-2])
    breakout = prev["close"] > prior_ceiling
    retest = (
        breakout
        and last["low"] <= prior_ceiling + atr * 0.25
        and last["close"] >= prior_ceiling
        and rv >= 1.2
    )
    specs.append(
        (
            "Breakout and retest",
            prior_ceiling,
            prior_ceiling - atr,
            retest,
            breakout,
            "5m breakout, then a held retest with relative volume ≥ 1.2",
        )
    )
    pullback = bullish and last["low"] <= mean20 + atr * 0.25
    specs.append(
        (
            "Trend pullback",
            mean20,
            min(r["low"] for r in rows[-6:]) - atr * 0.25,
            pullback and last["close"] > prev["high"] and rv >= 1,
            pullback,
            "Bullish 1H/4H context and 5m close above previous high after EMA20 pullback",
        )
    )
    if quiet and support and resistance:
        specs.append(
            (
                "Range trading",
                support["upper"],
                support["lower"] - atr * 0.5,
                last["low"] <= support["upper"] and last["close"] > prev["high"] and rv >= 1,
                last["close"] < support["upper"] + atr,
                "Flat EMA regime, support rejection, then 5m close above previous high",
            )
        )
    output = []
    for name, trigger, stop, confirmed, armed, message in specs:
        entry = max(last["close"], trigger) if confirmed else trigger
        if stop <= 0 or entry <= stop:
            continue
        target = (
            resistance["lower"] if resistance and resistance["lower"] > entry else entry + 2 * atr
        )
        state = (
            "INVALIDATED"
            if last["close"] <= stop
            else "TRIGGERED"
            if confirmed
            else "ARMED"
            if armed
            else "WATCH"
        )
        output.append(
            {
                "setup": name,
                "state": state,
                "entry": entry,
                "entry_low": entry - atr * 0.1,
                "entry_high": entry + atr * 0.1,
                "trigger": trigger,
                "stop": stop,
                "targets": [target, max(target, entry + 2 * atr), max(target, entry + 3 * atr)],
                "timestamp": last["time"] + 300,
                "expires": last["time"] + 1200,
                "next_action": message,
                "relative_volume": rv,
                "rule_version": "rules-1",
                "validation": "Unvalidated rule; TRIGGERED does not mean BUY",
            }
        )
    return output


def decide(quality, indicators, zones):
    # Phase 3 safety gate: descriptive evidence is never a calibrated probability.
    evidence = []
    e20, e50, rsi = (indicators.get(k) for k in ("ema20", "ema50", "rsi"))
    if e20 and e50:
        evidence.append("EMA20 above EMA50" if e20 > e50 else "EMA20 below EMA50")
    if rsi is not None:
        evidence.append(f"RSI14 {rsi:.1f}; momentum is descriptive, not a probability")
    return {
        "state": "WAIT",
        "model_status": "NOT TRAINED",
        "probability": None,
        "reason": "No validated forecast or measured net edge. Trade recommendation withheld.",
        "data_quality": quality,
        "evidence": evidence,
        "contradictions": [
            "Forecast model unvalidated",
            "No authenticated holdings; never recommend shorting",
        ],
        "plan": None,
        "zones_available": len(zones),
    }
