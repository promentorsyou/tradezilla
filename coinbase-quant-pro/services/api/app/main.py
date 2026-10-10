import asyncio
import contextlib
import json
import os
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Literal

import websockets
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.backtesting.engine import BacktestInput, run
from app.coinbase.client import Coinbase, DataError, utc_now
from app.database.store import append, history
from app.indicators.core import calculate, records
from app.risk.trade_planner import RiskInput, calculate as risk_calculate
from app.signals.decision_engine import decide
from app.structure.patterns import detect as patterns
from app.structure.support_resistance import detect as zones

coinbase = Coinbase()
tasks = set()
jobs = {}
analysis_cache = {}
analysis_lock = asyncio.Semaphore(2)
limits = defaultdict(deque)
origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")


@asynccontextmanager
async def lifespan(app):
    yield
    for task in tasks:
        task.cancel()
    await coinbase.http.aclose()


app = FastAPI(title="Coinbase Quant Pro · read-only research", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.add_middleware(
    TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "api", "testserver"]
)


@app.middleware("http")
async def guard(request: Request, call_next):
    key = request.client.host if request.client else "unknown"
    queue = limits[key]
    now = time.monotonic()
    while queue and queue[0] < now - 60:
        queue.popleft()
    if len(queue) >= 120:
        return JSONResponse(
            {"detail": "Request limit exceeded"}, status_code=429, headers={"Retry-After": "60"}
        )
    queue.append(now)
    if request.method == "POST" and request.headers.get("origin") not in [None, *origins]:
        return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
    response = await call_next(request)
    response.headers.update(
        {
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
        }
    )
    return response


@app.exception_handler(DataError)
async def bad_data(request, exc):
    return JSONResponse({"detail": str(exc), "status": "UNAVAILABLE"}, status_code=503)


@app.get("/api/v1/health")
def health():
    return {"status": "ok", "mode": "public-read-only", "time": utc_now()}


@app.get("/api/v1/system/status")
def system():
    return {
        "mode": "local research",
        "last_coinbase_success": coinbase.last_success,
        "models": "NOT TRAINED",
        "orders_enabled": False,
        "limits": "Single API worker, two active backtests, 2000 bars per job",
    }


@app.get("/api/v1/markets")
async def markets():
    return {
        "products": await coinbase.markets(),
        "fetched_at": utc_now(),
        "source": "Coinbase public REST",
    }


@app.get("/api/v1/markets/{product}/ticker")
async def ticker(product: str):
    return {
        **await coinbase.product(product),
        "fetched_at": utc_now(),
        "source": "Coinbase public REST",
    }


@app.get("/api/v1/markets/{product}/candles")
async def candles(
    product: str,
    timeframe: Literal["1H", "4H", "1D", "1W"] = "1H",
    count: int = Query(500, ge=50, le=1500),
    end: int | None = None,
):
    data = await coinbase.candles(product, timeframe, count, end)
    return {k: v for k, v in data.items() if k != "raw"}


@app.get("/api/v1/markets/{product}/orderbook")
async def orderbook(product: str):
    await coinbase.product(product)
    data = await coinbase.get("/market/product_book", {"product_id": product, "limit": 15}, ttl=5)
    book = data.get("pricebook", {})
    bids, asks = book.get("bids", []), book.get("asks", [])
    bid_depth = sum(float(x["size"]) for x in bids)
    ask_depth = sum(float(x["size"]) for x in asks)
    bid = float(bids[0]["price"]) if bids else None
    ask = float(asks[0]["price"]) if asks else None
    return {
        "bids": bids,
        "asks": asks,
        "timestamp": book.get("time"),
        "fetched_at": utc_now(),
        "spread_bps": (ask - bid) / ((ask + bid) / 2) * 10000 if bid and ask else None,
        "imbalance": (bid_depth - ask_depth) / (bid_depth + ask_depth)
        if bid_depth + ask_depth
        else None,
        "mode": "REST snapshot, 5-second polling; not a reconstructed L2 stream",
    }


async def analysis(product, timeframe):
    key = (product, timeframe)
    cached = analysis_cache.get(key)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    async with analysis_lock:
        data = await coinbase.candles(product, timeframe, 300 if timeframe == "1W" else 500)
        closed = [r for r in data["candles"] if r["complete"]]
        if not closed:
            raise DataError("No completed candles available")
        # Restrict calculations to the contiguous tail, disclosing discarded history.
        # Never treat pre/post-delisting bars as adjacent regular observations.
        seconds = {"1H": 3600, "4H": 14400, "1D": 86400, "1W": 604800}[timeframe]
        breaks = [
            i for i in range(1, len(closed)) if closed[i]["time"] - closed[i - 1]["time"] != seconds
        ]
        discarded = breaks[-1] if breaks else 0
        closed = closed[discarded:]
        usable = data["quality"] != "STALE"
        series = records(calculate(closed)) if usable else []
        latest = series[-1] if series else {}
        levels = zones(closed, latest.get("atr")) if series else []
        signal = decide(data["quality"], latest, levels)
        result = {
            "product_id": product,
            "timeframe": timeframe,
            "source": data["source"],
            "fetched_at": data["fetched_at"],
            "calculated_at": utc_now(),
            "source_candle": closed[-1]["time"],
            "quality": data["quality"],
            "observations": len(closed),
            "discarded_before_gap": discarded,
            "history_note": "Indicators use only the contiguous completed-candle tail. Warmup nulls are withheld.",
            "indicators": latest,
            "series": series,
            "zones": levels,
            "patterns": patterns(closed) if series else [],
            "signal": signal,
            "trend": ("Bullish" if latest["ema20"] > latest["ema50"] else "Bearish")
            if latest.get("ema20") and latest.get("ema50")
            else "Insufficient",
            "warmup": [k for k, v in latest.items() if v is None],
        }
        append(
            "signal",
            product,
            {
                "timeframe": timeframe,
                "source_candle": closed[-1]["time"],
                "price": closed[-1]["close"],
                "signal": signal,
            },
        )
        append("candle_snapshot", product, data)
        analysis_cache[key] = (time.monotonic(), result)
        return result


@app.get("/api/v1/analysis/{product}")
async def get_analysis(product: str, timeframe: Literal["1H", "4H", "1D", "1W"] = "1H"):
    return await analysis(product, timeframe)


@app.get("/api/v1/analysis/{product}/{section}")
async def analysis_section(
    product: str,
    section: Literal["indicators", "levels", "patterns", "structure"],
    timeframe: Literal["1H", "4H", "1D", "1W"] = "1H",
):
    result = await analysis(product, timeframe)
    return {
        "source_candle": result["source_candle"],
        "data": result[{"levels": "zones", "structure": "trend"}.get(section, section)],
    }


@app.get("/api/v1/models")
@app.get("/api/v1/models/metrics")
def models():
    return {
        "models": [
            {"name": name, "status": "NOT TRAINED", "metrics": None}
            for name in [
                "Random walk baseline",
                "Majority class",
                "Logistic regression",
                "Random Forest",
                "XGBoost",
                "LightGBM",
                "ARIMA",
                "GARCH",
                "Hidden Markov",
            ]
        ],
        "reason": "Training, purged walk-forward validation and calibration are not implemented. No invented metrics.",
    }


@app.get("/api/v1/forecasts/{product}")
def forecasts(product: str):
    return {
        "product_id": product,
        "status": "NOT TRAINED",
        "horizons": ["1H", "4H", "24H", "7D"],
        "probabilities": None,
        "intervals": None,
        "reason": "No calibrated model is registered",
    }


@app.get("/api/v1/signals/history")
def signal_history():
    return {"records": history("signal")}


@app.get("/api/v1/signals/{product}")
def product_signals(product: str):
    return {"records": history("signal", product)}


@app.post("/api/v1/risk/calculate")
def risk(payload: RiskInput):
    return risk_calculate(payload)


async def perform_job(identifier, payload):
    try:
        data = await coinbase.candles(payload.product, payload.timeframe, payload.bars, payload.end)
        if data["quality"] != "VALID":
            raise DataError("Backtest refused: stale or gapped market history")
        result = await asyncio.to_thread(run, data["candles"], payload)
        result["source"] = {k: data[k] for k in ("source", "fetched_at", "product_id", "timeframe")}
        result["config"] = payload.model_dump()
        append("backtest", payload.product, result, identifier)
        jobs[identifier] = result
    except Exception as exc:
        jobs[identifier] = {"status": "failed", "detail": str(exc)}


@app.post("/api/v1/backtests", status_code=202)
async def backtest(payload: BacktestInput):
    if sum(j.get("status") == "running" for j in jobs.values()) >= 2:
        raise HTTPException(429, "Two backtests already running")
    if len(jobs) >= 100:
        for identifier in list(jobs):
            if jobs[identifier]["status"] != "running":
                del jobs[identifier]
                break
    identifier = str(uuid.uuid4())
    jobs[identifier] = {"status": "running"}
    task = asyncio.create_task(perform_job(identifier, payload))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {"job_id": identifier, "status": "running"}


@app.get("/api/v1/backtests/{identifier}")
def backtest_result(identifier: str):
    if identifier in jobs:
        return jobs[identifier]
    result = next((r for r in history("backtest", limit=100) if r["id"] == identifier), None)
    if not result:
        raise HTTPException(404, "Unknown backtest")
    return result


@app.websocket("/ws/markets")
async def stream(socket: WebSocket, product: str = "XRP-USDC"):
    if socket.headers.get("origin") not in [None, *origins]:
        await socket.close(code=1008)
        return
    await socket.accept()
    try:
        metadata = await coinbase.product(product)
        source = metadata.get("alias") or product
        # Official public USDC channel mapping; never relabel the source silently.
        attempt = 0
        while True:
            try:
                await socket.send_json(
                    {"type": "status", "status": "CONNECTING", "source_product": source}
                )
                async with websockets.connect(
                    "wss://advanced-trade-ws.coinbase.com",
                    open_timeout=15,
                    ping_interval=20,
                    max_size=2**20,
                ) as upstream:
                    for channel in ("heartbeats", "ticker"):
                        await upstream.send(
                            json.dumps(
                                {"type": "subscribe", "channel": channel, "product_ids": [source]}
                            )
                        )
                    previous_sequence = None
                    await socket.send_json(
                        {"type": "reconcile", "reason": "stream connected; refresh REST snapshot"}
                    )
                    while True:
                        message = json.loads(await asyncio.wait_for(upstream.recv(), timeout=12))
                        if message.get("type") == "error":
                            raise DataError("Coinbase rejected subscription")
                        channel = message.get("channel")
                        sequence = message.get("sequence_num")
                        if sequence is not None:
                            # This public feed numbers all messages on the connection,
                            # including subscription acknowledgements and heartbeats.
                            if previous_sequence is not None and sequence > previous_sequence + 1:
                                await socket.send_json(
                                    {"type": "reconcile", "reason": "sequence gap"}
                                )
                                raise DataError("Sequence gap; reconnecting")
                            if previous_sequence is not None and sequence <= previous_sequence:
                                continue
                            previous_sequence = sequence
                        if channel == "heartbeats":
                            await socket.send_json(
                                {"type": "heartbeat", "time": message.get("timestamp")}
                            )
                        if channel == "ticker":
                            for event in message.get("events", []):
                                for tick in event.get("tickers", []):
                                    if tick.get("product_id") == source:
                                        await socket.send_json(
                                            {
                                                "type": "ticker",
                                                "product_id": product,
                                                "source_product": source,
                                                "time": message["timestamp"],
                                                "price": tick["price"],
                                                "change": tick.get("price_percent_chg_24_h"),
                                            }
                                        )
                                        attempt = 0
            except (WebSocketDisconnect, RuntimeError):
                return
            except (OSError, TimeoutError, websockets.WebSocketException, DataError):
                attempt += 1
                await socket.send_json({"type": "status", "status": "DISCONNECTED"})
                await asyncio.sleep(min(2 ** min(attempt, 5), 30))
    except (WebSocketDisconnect, RuntimeError):
        pass
    except DataError as exc:
        with contextlib.suppress(Exception):
            await socket.send_json({"type": "status", "status": "DISCONNECTED", "reason": str(exc)})
            await socket.close()
