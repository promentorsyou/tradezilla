import asyncio
import json

from fastapi import WebSocketDisconnect

from app.main import coinbase, stream


async def test_connection_wide_sequences_do_not_trigger_false_gap(monkeypatch):
    messages = [
        {"channel": "subscriptions", "sequence_num": 0},
        {
            "channel": "ticker",
            "sequence_num": 1,
            "timestamp": "2026-10-10T00:00:00Z",
            "events": [{"tickers": [{"product_id": "XRP-USD", "price": "1"}]}],
        },
        {"channel": "subscriptions", "sequence_num": 2},
        {"channel": "heartbeats", "sequence_num": 3, "timestamp": "2026-10-10T00:00:01Z"},
        {
            "channel": "ticker",
            "sequence_num": 4,
            "timestamp": "2026-10-10T00:00:01Z",
            "events": [{"tickers": [{"product_id": "XRP-USD", "price": "1.01"}]}],
        },
    ]
    observed = []

    class Downstream:
        headers = {}

        async def accept(self):
            pass

        async def send_json(self, value):
            observed.append(value)
            if sum(v["type"] == "ticker" for v in observed) == 2:
                raise WebSocketDisconnect()

    class Upstream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def send(self, message):
            assert json.loads(message)["channel"] in ["ticker", "heartbeats"]

        async def recv(self):
            return json.dumps(messages.pop(0))

    async def metadata(_):
        return {"alias": "XRP-USD"}

    monkeypatch.setattr(coinbase, "product", metadata)
    monkeypatch.setattr("app.main.websockets.connect", lambda *a, **k: Upstream())
    await asyncio.wait_for(stream(Downstream()), 0.5)
    assert sum(v["type"] == "ticker" for v in observed) == 2
    assert not any(v.get("status") == "DISCONNECTED" for v in observed)
    assert not any(v.get("reason") == "sequence gap" for v in observed)
