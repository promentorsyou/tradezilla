"""Publish public spot-market history for the static Quant Pro page.

No account client, authentication, or private environment variables are used.
Coinbase REST disallows browser CORS; GitHub generates this public snapshot.
"""

import concurrent.futures
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://api.coinbase.com/api/v3/brokerage"
PRODUCTS = ["XRP-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "ADA-USDC", "ZEC-USDC"]
sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent / "coinbase-quant-pro/services/api")
)
from app.signals.decision_engine import candidates
from quant_journal import extend_journal


def coverage(rows, seconds):
    gaps = [
        b["time"] for a, b in zip(rows, rows[1:]) if b["time"] - a["time"] != seconds
    ]
    tail = next((i for i, r in enumerate(rows) if gaps and r["time"] == gaps[-1]), 0)
    return {
        "bars": len(rows),
        "gaps": len(gaps),
        "contiguous": len(rows) - tail,
        "first": rows[0]["time"] if rows else None,
        "last": rows[-1]["time"] if rows else None,
    }


def public_book(product):
    book = get("/market/product_book", {"product_id": product, "limit": 100}).get(
        "pricebook", {}
    )
    if book.get("product_id") != product:
        raise ValueError("Order book product mismatch")
    for side in ("bids", "asks"):
        for level in book.get(side, []):
            if not all(
                math.isfinite(float(level[k])) and float(level[k]) > 0
                for k in ("price", "size")
            ):
                raise ValueError("Invalid order book level")
        book[side] = sorted(
            book.get(side, []), key=lambda r: float(r["price"]), reverse=side == "bids"
        )
    if (
        not book["bids"]
        or not book["asks"]
        or float(book["bids"][0]["price"]) >= float(book["asks"][0]["price"])
    ):
        raise ValueError("Empty or crossed book")
    book["scope"] = (
        "Exact requested USDC REST book; top 100 levels, scheduled observation, not live execution"
    )
    return book


def get(path, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "TradeZilla-PublicResearch/1.0"}
            )
            with urllib.request.urlopen(req, timeout=25) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code != 429 and exc.code < 500:
                raise
            if attempt == 2:
                raise
        except (OSError, ValueError):
            if attempt == 2:
                raise
        time.sleep(2**attempt)


def candles(product, granularity, seconds, count, now):
    end = now // seconds * seconds  # current open candle is excluded
    start = end - count * seconds
    found = {}
    for cursor in range(start, end, 350 * seconds):
        data = get(
            "/market/products/" + product + "/candles",
            {
                "start": cursor,
                "end": min(cursor + 349 * seconds, end - 1),
                "granularity": granularity,
                "limit": 350,
            },
        )
        for raw in data.get("candles", []):
            row = {k: float(raw[k]) for k in ("open", "high", "low", "close", "volume")}
            row["time"] = int(raw["start"])
            if not all(math.isfinite(v) for v in row.values()):
                raise ValueError("Nonfinite public candle")
            if (
                row["low"] <= 0
                or row["high"] < max(row["open"], row["close"])
                or row["low"] > min(row["open"], row["close"])
                or row["volume"] < 0
                or row["time"] % seconds
            ):
                raise ValueError("Invalid public candle")
            if start <= row["time"] < end:
                found[row["time"]] = row
    return sorted(found.values(), key=lambda r: r["time"])


def weeklies(daily):
    groups = {}
    for c in daily:
        day = datetime.fromtimestamp(c["time"], timezone.utc)
        start = c["time"] - day.weekday() * 86400
        groups.setdefault(start, []).append(c)
    out = []
    for start, rows in sorted(groups.items()):
        if [r["time"] for r in rows] != list(range(start, start + 604800, 86400)):
            continue
        out.append(
            {
                "time": start,
                "open": rows[0]["open"],
                "high": max(r["high"] for r in rows),
                "low": min(r["low"] for r in rows),
                "close": rows[-1]["close"],
                "volume": sum(r["volume"] for r in rows),
            }
        )
    return out


def build_product(product, now):
    p = get("/market/products/" + product)
    if (
        p.get("product_id") != product
        or p.get("quote_currency_id") != "USDC"
        or p.get("product_type") != "SPOT"
        or p.get("status") != "online"
        or any(p.get(k) for k in ("is_disabled", "trading_disabled", "cancel_only"))
    ):
        return {
            "product_id": product,
            "available": False,
            "reason": "Not an active spot product",
        }
    daily = candles(product, "ONE_DAY", 86400, 1500, now)
    frames = {
        "1m": candles(product, "ONE_MINUTE", 60, 300, now),
        "5m": candles(product, "FIVE_MINUTE", 300, 300, now),
        "15m": candles(product, "FIFTEEN_MINUTE", 900, 300, now),
        "1H": candles(product, "ONE_HOUR", 3600, 300, now),
        "4H": candles(product, "FOUR_HOUR", 14400, 300, now),
        "1D": daily[-300:],
        "1W": weeklies(daily)[-220:],
    }
    spans = dict(zip(frames, [60, 300, 900, 3600, 14400, 86400, 604800]))
    try:
        book = public_book(product)
    except (OSError, ValueError) as exc:
        book = {"product_id": product, "bids": [], "asks": [], "error": str(exc)}
    return {
        "product_id": product,
        "available": True,
        "alias": p.get("alias") or product,
        "quote": p["quote_currency_id"],
        "base_increment": p["base_increment"],
        "base_min_size": p.get("base_min_size"),
        "quote_min_size": p.get("quote_min_size"),
        "limit_only": p.get("limit_only", False),
        "post_only": p.get("post_only", False),
        "book": book,
        "coverage": {f: coverage(rows, spans[f]) for f, rows in frames.items()},
        "candle_product": product,
        "ticker_product": p.get("alias") or product,
        "basis_verified": False,
        "mapping_note": "REST candles and book requested in USDC. Public ticker/L2 is a USD alias; settlement basis and account eligibility are not verified. No exact USDC live execution claim.",
        "candidates": candidates(frames["5m"], frames["1H"], frames["4H"]),
        "name": p["base_name"],
        "price": p["price"],
        "change": p["price_percentage_change_24h"],
        "volume": p["volume_24h"],
        "increment": p["quote_increment"],
        "frames": frames,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    now = int(get("/time")["epochSeconds"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        products = list(pool.map(lambda p: build_product(p, now), PRODUCTS))
    result = {
        "version": 1,
        "mode": "scheduled-research",
        "source": "Coinbase Advanced Trade public REST",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "exchange_time": now,
        "note": "Completed candles only. GitHub-scheduled snapshot; ticker is streamed separately.",
        "products": products,
    }
    destination = Path(__file__).resolve().parent.parent / "docs/quant-data.json"
    previous = json.loads(destination.read_text()).get('journal', {}) if destination.exists() else {}
    result['journal'] = extend_journal(previous, products, int(time.time()))
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    temporary.replace(destination)
    print(
        "Public Quant Pro snapshot saved: "
        + ", ".join(p["product_id"] for p in products)
    )


if __name__ == "__main__":
    main()
