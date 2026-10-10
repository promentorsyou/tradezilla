"""Immutable public rule-observation journal, NOT live/paper executions.

Observations and outcomes are separate append-only event types. Retain latest
100 observations in the snapshot; earlier versions remain in Git history.
Never read or store user budgets, holdings or account data.
"""

import hashlib
from decimal import Decimal as D


def extend_journal(previous, products, now):
    observations = list(previous.get("observations", []))
    outcomes = list(previous.get("outcomes", []))
    ids = {r["id"] for r in observations}
    settled = {r["observation_id"] for r in outcomes}
    by_product = {p["product_id"]: p for p in products}
    for old in observations:
        if old["id"] in settled or now < old["start"] + 3600:
            continue
        p = by_product.get(old["product"])
        rows = (p or {}).get("frames", {}).get("5m", [])
        window = [r for r in rows if old["start"] <= r["time"] < old["start"] + 3600]
        outcome = {
            "observation_id": old["id"],
            "recorded_at": now,
            "entry_filled": None,
            "mode": "Hypothetical next-open path only; WAIT observation, not an executed signal",
        }
        if [r["time"] for r in window] != list(
            range(old["start"], old["start"] + 3600, 300)
        ):
            outcome.update(status="UNRESOLVED_MISSING_DATA", net_return=None)
        else:
            entry = window[0]["open"]
            stop = old["stop"]
            target = old["target"]
            if not stop < entry < target:
                outcome.update(
                    status="INVALIDATED_BEFORE_HYPOTHETICAL_ENTRY", net_return=None
                )
            else:
                status, exit_price = "TIMEOUT", window[-1]["close"]
                for r in window:
                    if r["low"] <= stop:
                        status, exit_price = "STOP_FIRST", min(r["open"], stop)
                        break
                    if r["high"] >= target:
                        status, exit_price = "TARGET_FIRST", target
                        break
                net = (
                    D(str(exit_price))
                    * D(".9995")
                    * D(".999")
                    / (D(str(entry)) * D("1.0005") * D("1.001"))
                    - 1
                )
                outcome.update(
                    status=status, net_return=str(net), hypothetical_entry=entry
                )
        outcomes.append(outcome)
    for p in products:
        for c in p.get("candidates", []):
            if c["state"] not in ("ARMED", "TRIGGERED"):
                continue
            key = f"{p['product_id']}:{c['timestamp']}:{c['setup']}:{c['rule_version']}"
            identifier = hashlib.sha256(key.encode()).hexdigest()[:20]
            if identifier in ids:
                continue
            observations.append(
                {
                    "id": identifier,
                    "product": p["product_id"],
                    "recorded_at": now,
                    "signal_timestamp": c["timestamp"],
                    "start": (now // 300 + 1) * 300,
                    "action": "WAIT",
                    "state": c["state"],
                    "setup": c["setup"],
                    "entry": c["entry"],
                    "stop": c["stop"],
                    "target": c["targets"][0],
                    "hold_minutes": 60,
                    "intended_order": "None; research observation",
                    "book_time": p.get("book", {}).get("time"),
                    "best_bid": p.get("book", {}).get("bids", [])[:1],
                    "best_ask": p.get("book", {}).get("asks", [])[:1],
                    "model_version": None,
                    "probabilities": None,
                    "rule_version": c["rule_version"],
                    "fee_pct_per_leg": 0.1,
                    "slippage_pct_per_leg": 0.05,
                    "original_explanation": c["next_action"]
                    + "; execution/model gates unqualified.",
                }
            )
            ids.add(identifier)
    observations = observations[-100:]
    retained = {r["id"] for r in observations}
    return {
        "observations": observations,
        "outcomes": [r for r in outcomes if r["observation_id"] in retained],
        "retention": "Latest 100 immutable observations; earlier snapshots archived in Git. Outcomes appended separately.",
        "scope": "Rule observations, not recommendations or paper trades; no validated model track record",
    }
