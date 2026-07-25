"""Unified trade-event stream.

The Advanced Trade fills endpoint only returns Advanced orders. Anything you
did through the simple Buy/Sell screen, plus conversions and reward payouts,
lives in the v2 account ledger instead. Using only one source produces
nonsense P&L: sells whose matching buys are missing look like pure profit.

This module merges both into one chronological event list:

  * advanced fills      - exact price, size, and per-fill commission
  * simple buy/sell     - v2 "buy"/"sell" (no commission line; Coinbase
                          prices these with an embedded spread)
  * conversions         - v2 "trade" (e.g. SOL -> USDC)
  * reward payouts      - staking/card/interest credits, booked at the USD
                          value Coinbase reported at receipt, which is the
                          correct cost basis

v2 rows of type "advanced_trade_fill" are dropped: the fills endpoint already
covers them and counting both would double every Advanced trade.
"""
from __future__ import annotations

import json
import os
from datetime import datetime

from cb_client import get_json

STABLES = {"USD", "USDC", "USDT", "DAI"}

REWARD_TYPES = {
    "staking_reward", "inflation_reward", "interest", "credit_card_reward",
    "incentives_rewards_payout", "subscription_rebate", "reward_income",
}
# purely internal moves - no acquisition or disposal
IGNORED_TYPES = {
    "advanced_trade_fill", "staking_transfer", "unstaking_transfer",
    "fiat_deposit", "fiat_withdrawal", "exchange_deposit", "exchange_withdrawal",
    "pro_deposit", "pro_withdrawal", "vault_withdrawal", "request", "transfer",
    "retail_simple_dust", "sell_refund",
}

# A clawback reverses a funding payment: Coinbase takes back both the cash and
# the coins it bought. The coins leave the wallet, so the position must shrink,
# but it is not a trade - proceeds equal the original cost, so P&L is zero.
REVERSAL_TYPES = {"clawback"}


def _iso(ts: str) -> str:
    return ts.replace("Z", "+00:00") if ts else ts


def advanced_events(fills: list[dict]) -> list[dict]:
    out = []
    for f in fills:
        price = float(f["price"])
        size = float(f["size"])
        if f.get("size_in_quote"):
            quote, qty = size, (size / price if price else 0.0)
        else:
            qty, quote = size, size * price
        product = f["product_id"]
        out.append({
            "time": f["trade_time"],
            "symbol": product.split("-")[0],
            "quote_ccy": product.split("-")[1],
            "product": product,
            "side": f["side"],
            "qty": qty,
            "quote": quote,
            "price": price,
            "fee": float(f.get("commission") or 0),
            "source": "advanced",
            "liquidity": f.get("liquidity_indicator", ""),
        })
    return out


def ledger_events(all_tx: dict[str, list[dict]]) -> list[dict]:
    """Convert v2 ledger rows into events. Stablecoin legs are skipped so a
    conversion is counted once, on its crypto side."""
    out = []
    for currency, rows in all_tx.items():
        if currency in STABLES:
            continue
        for t in rows:
            ttype = t["type"]
            if ttype in IGNORED_TYPES:
                continue
            qty = float(t["amount"]["amount"])
            usd = float((t.get("native_amount") or {}).get("amount") or 0)
            if abs(qty) < 1e-12:
                continue

            if ttype in REWARD_TYPES:
                if qty <= 0:
                    continue
                out.append({
                    "time": t["created_at"], "symbol": currency,
                    "quote_ccy": "USD", "product": f"{currency}-USD",
                    "side": "BUY", "qty": qty, "quote": abs(usd),
                    "price": (abs(usd) / qty) if qty else 0.0,
                    "fee": 0.0, "source": "reward", "liquidity": "",
                })
                continue

            if ttype in REVERSAL_TYPES:
                # coins removed from the wallet; book at the reversed cash value
                out.append({
                    "time": t["created_at"], "symbol": currency,
                    "quote_ccy": "USD", "product": f"{currency}-USD",
                    "side": "SELL" if qty < 0 else "BUY", "qty": abs(qty),
                    "quote": abs(usd), "price": (abs(usd) / abs(qty)) if qty else 0.0,
                    "fee": 0.0, "source": "reversal", "liquidity": "",
                })
                continue

            if ttype in ("buy", "sell", "trade", "send", "receive"):
                side = "BUY" if qty > 0 else "SELL"
                q = abs(qty)
                value = abs(usd)
                out.append({
                    "time": t["created_at"], "symbol": currency,
                    "quote_ccy": "USD", "product": f"{currency}-USD",
                    "side": side, "qty": q, "quote": value,
                    "price": (value / q) if q else 0.0,
                    "fee": 0.0,
                    "source": "simple" if ttype in ("buy", "sell") else ttype,
                    "liquidity": "",
                })
    return out


def fetch_ledger() -> dict[str, list[dict]]:
    accounts, path, params = [], "/v2/accounts", {"limit": "100"}
    while True:
        d = get_json(path, params)
        accounts.extend(d.get("data", []))
        nxt = (d.get("pagination") or {}).get("next_uri")
        if not nxt:
            break
        path, _, q = nxt.partition("?")
        params = dict(kv.split("=") for kv in q.split("&")) if q else {}

    out: dict[str, list[dict]] = {}
    for a in accounts:
        cur = a["balance"]["currency"]
        txs, p, prm = [], f"/v2/accounts/{a['id']}/transactions", {"limit": "100"}
        while True:
            try:
                d = get_json(p, prm)
            except Exception:
                break
            txs.extend(d.get("data", []))
            nxt = (d.get("pagination") or {}).get("next_uri")
            if not nxt:
                break
            p, _, q = nxt.partition("?")
            prm = dict(kv.split("=") for kv in q.split("&")) if q else {}
        if txs:
            out.setdefault(cur, []).extend(txs)
    return out


def merged_events(fills: list[dict], ledger: dict[str, list[dict]]) -> list[dict]:
    ev = advanced_events(fills) + ledger_events(ledger)
    ev.sort(key=lambda e: _iso(e["time"]))
    return ev
