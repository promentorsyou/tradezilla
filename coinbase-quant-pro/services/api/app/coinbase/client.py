import asyncio
import re
import time
from datetime import UTC, datetime

import httpx

BASE = "https://api.coinbase.com/api/v3/brokerage"
FRAMES = {
    "1H": ("ONE_HOUR", 3600),
    "4H": ("FOUR_HOUR", 14400),
    "1D": ("ONE_DAY", 86400),
    "1W": ("ONE_DAY", 86400),
}


def utc_now():
    return datetime.now(UTC).isoformat()


class DataError(Exception):
    pass


def validate_candles(raw, seconds, now):
    unique = {}
    for r in raw:
        c = {k: float(r[k]) for k in ("open", "high", "low", "close", "volume")}
        c["time"] = int(r["start"])
        import math

        if (
            not all(math.isfinite(v) for v in c.values())
            or min(c[k] for k in ("open", "high", "low", "close")) <= 0
            or c["high"] < max(c["open"], c["close"])
            or c["low"] > min(c["open"], c["close"])
            or c["volume"] < 0
            or c["time"] % seconds != 0
            or c["time"] > now
        ):
            raise DataError("Invalid exchange candle; analysis withheld")
        c["complete"] = c["time"] + seconds <= now
        unique[c["time"]] = c
    candles = sorted(unique.values(), key=lambda c: c["time"])
    gaps = [b["time"] for a, b in zip(candles, candles[1:]) if b["time"] - a["time"] != seconds]
    return candles, gaps


def weekly(daily, now):
    groups = {}
    for c in daily:
        date = datetime.fromtimestamp(c["time"], UTC)
        start = c["time"] - date.weekday() * 86400
        groups.setdefault(start, []).append(c)
    result = []
    for start, rows in sorted(groups.items()):
        expected = list(range(start, min(start + 604800, int(now // 86400) * 86400 + 86400), 86400))
        if [r["time"] for r in rows] != expected:
            continue  # Never manufacture a partial historical week from missing days.
        result.append(
            {
                "time": start,
                "open": rows[0]["open"],
                "high": max(r["high"] for r in rows),
                "low": min(r["low"] for r in rows),
                "close": rows[-1]["close"],
                "volume": sum(r["volume"] for r in rows),
                "complete": len(rows) == 7 and start + 604800 <= now,
            }
        )
    return result


class Coinbase:
    def __init__(self):
        self.http = httpx.AsyncClient(
            base_url=BASE, timeout=20, headers={"Cache-Control": "no-cache"}
        )
        self.cache = {}
        self.lock = asyncio.Semaphore(3)
        self.last_success = None

    async def get(self, path, params=None, ttl=10):
        if not (path.startswith("/market/") or path == "/time"):
            raise DataError("Only public market endpoints are permitted")
        key = (path, str(params))
        hit = self.cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
        async with self.lock:
            for attempt in range(4):
                try:
                    response = await self.http.get(path, params=params)
                    if response.status_code == 429 or response.status_code >= 500:
                        if attempt == 3:
                            raise DataError("Coinbase is rate limited or unavailable; retry later")
                        try:
                            wait = float(response.headers.get("retry-after", 2**attempt))
                        except ValueError:
                            wait = 2**attempt
                        await asyncio.sleep(min(max(wait, 0.1), 8))
                        continue
                    if response.status_code != 200:
                        raise DataError(
                            f"Coinbase rejected market request ({response.status_code})"
                        )
                    data = response.json()
                    self.last_success = utc_now()
                    if len(self.cache) > 1000:
                        self.cache.clear()
                    self.cache[key] = (time.monotonic(), data)
                    return data
                except httpx.RequestError as exc:
                    if attempt == 3:
                        raise DataError("Coinbase network unavailable") from exc
                    await asyncio.sleep(2**attempt)

    async def product(self, product):
        if not re.fullmatch(r"[A-Z0-9]{1,20}-[A-Z0-9]{1,20}", product):
            raise DataError("Invalid product identifier")
        p = await self.get(f"/market/products/{product}", ttl=10)
        if p.get("product_type") != "SPOT" or p.get("is_disabled") or p.get("status") != "online":
            raise DataError("Product is not an active Coinbase spot market")
        return p

    async def markets(self):
        products = []
        for offset in range(0, 5000, 1000):
            data = await self.get(
                "/market/products",
                {"product_type": "SPOT", "limit": 1000, "offset": offset},
                ttl=60,
            )
            page = data.get("products", [])
            products.extend(
                p
                for p in page
                if p.get("product_type") == "SPOT"
                and p.get("status") == "online"
                and not p.get("is_disabled")
            )
            if len(page) < 1000:
                break
        return list({p["product_id"]: p for p in products}.values())

    async def candles(self, product, frame="1H", count=500, end=None):
        await self.product(product)
        granularity, seconds = FRAMES[frame]
        clock = await self.get("/time", ttl=30)
        now = int(clock["epochSeconds"])
        end = min(end or now, now)
        buckets = count * 7 + 7 if frame == "1W" else count
        start = (end // seconds - buckets + 1) * seconds
        raw = []
        cursor = start
        while cursor <= end:
            stop = min(cursor + 349 * seconds, end)
            chunk = await self.get(
                f"/market/products/{product}/candles",
                {"start": str(cursor), "end": str(stop), "granularity": granularity, "limit": 350},
                ttl=30,
            )
            raw.extend(chunk.get("candles", []))
            cursor += 350 * seconds
        candles, gaps = validate_candles(raw, seconds, now)
        candles = [c for c in candles if start <= c["time"] <= end]
        if frame == "1W":
            candles = weekly(candles, now)
        candles = candles[-count:]
        duration = 604800 if frame == "1W" else seconds
        stale = not candles or (end == now and candles[-1]["time"] + duration * 2 < now)
        return {
            "product_id": product,
            "timeframe": frame,
            "candles": candles,
            "gaps": gaps,
            "quality": "STALE" if stale else ("GAPS" if gaps else "VALID"),
            "source": "Coinbase Advanced Trade public REST",
            "fetched_at": utc_now(),
            "exchange_time": now,
            "clock_skew_seconds": round(time.time() - now, 2),
            "raw": raw,
        }
