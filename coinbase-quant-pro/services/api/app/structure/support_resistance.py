"""Confirmed 3-left/3-right swing clusters; scores are descriptive, not probability."""

import math


def detect(candles, atr=None, window=3):
    if len(candles) < window * 2 + 1:
        return []
    price = candles[-1]["close"]
    tolerance = max((atr or price * 0.005) * 0.35, price * 0.001)
    pivots = []
    for i in range(window, len(candles) - window):
        row, nearby = candles[i], candles[i - window : i + window + 1]
        for side, fn in (("high", max), ("low", min)):
            if row[side] == fn(r[side] for r in nearby):
                pivots.append(
                    {
                        "price": row[side],
                        "index": i,
                        "volume": row["volume"],
                        "confirmed_at": candles[i + window]["time"],
                    }
                )
    clusters = []
    for p in sorted(pivots, key=lambda r: r["price"]):
        if (
            clusters
            and abs(p["price"] - sum(x["price"] for x in clusters[-1]) / len(clusters[-1]))
            <= tolerance
        ):
            clusters[-1].append(p)
        else:
            clusters.append([p])
    zones = []
    mean_volume = sum(r["volume"] for r in candles) / len(candles)
    for cluster in clusters:
        center = sum(r["price"] * max(r["volume"], 1) for r in cluster) / sum(
            max(r["volume"], 1) for r in cluster
        )
        recency = math.exp(-(len(candles) - 1 - max(r["index"] for r in cluster)) / 100)
        touches = len(cluster)
        volume = sum(r["volume"] for r in cluster) / touches / max(mean_volume, 1e-12)
        factors = {
            "touches": min(40, touches * 10),
            "recency": round(30 * recency),
            "volume": round(min(30, volume * 15)),
        }
        lower, upper = center - tolerance / 2, center + tolerance / 2
        if lower <= price <= upper:
            continue
        side = "support" if upper < price else "resistance"
        zones.append(
            {
                "type": side,
                "lower": lower,
                "upper": upper,
                "strength": sum(factors.values()),
                "touches": touches,
                "status": "candidate",
                "factors": factors,
                "confirmed_at": max(p["confirmed_at"] for p in cluster),
                "methodologies": ["confirmed_swing_cluster", "volume_weighted_center"],
                "invalidation": "Two completed closes beyond the far boundary; role flips require a new retest.",
            }
        )
    return sum(
        [
            sorted(
                [z for z in zones if z["type"] == side],
                key=lambda z: abs((z["upper"] + z["lower"]) / 2 - price),
            )[:3]
            for side in ("support", "resistance")
        ],
        [],
    )
