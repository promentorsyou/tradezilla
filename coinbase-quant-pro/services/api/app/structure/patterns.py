def detect(candles):
    if len(candles) < 2:
        return []
    a, b = candles[-2:]
    body, span = abs(b["close"] - b["open"]), b["high"] - b["low"]
    if span == 0:
        return []
    lower = min(b["open"], b["close"]) - b["low"]
    upper = b["high"] - max(b["open"], b["close"])
    rules = {
        "Doji": body / span <= 0.1,
        "Hammer candidate": lower >= 2 * body and upper <= 0.2 * span and body > 0.1 * span,
        "Shooting star candidate": upper >= 2 * body and lower <= 0.2 * span and body > 0.1 * span,
        "Inside bar": b["high"] < a["high"] and b["low"] > a["low"],
        "Bullish engulfing": a["close"] < a["open"]
        and b["close"] > b["open"]
        and b["open"] <= a["close"]
        and b["close"] >= a["open"],
        "Bearish engulfing": a["close"] > a["open"]
        and b["close"] < b["open"]
        and b["open"] >= a["close"]
        and b["close"] <= a["open"],
    }
    return [
        {
            "name": name,
            "time": b["time"],
            "body_fraction": body / span,
            "status": "completed candle; predictive value unvalidated",
        }
        for name, valid in rules.items()
        if valid
    ]
