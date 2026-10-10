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
