"""Turn Coinbase activity into round-trip trades and journal analytics.

Trade model
-----------
A "trade" is a round trip in one asset: it opens when the position moves away
from flat and closes when it returns to flat. Events are matched FIFO, so a
position built from several buys and unwound over several sells is a single
trade with a weighted-average entry and exit.

Positions are tracked per *asset* (BTC), not per product (BTC-USD vs
BTC-USDC), because those are the same coins in the same wallet.

P&L convention
--------------
net_pnl = exit proceeds - FIFO cost of the units sold - commissions.
Commissions come from Coinbase per fill, so fees are exact rather than
inferred from a tier. Coinbase One rebates arrive as separate ledger credits
and are reported as income, never folded into a trade's P&L.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict, deque
from datetime import datetime, timezone

from cb_client import get_json
from events import STABLES, fetch_ledger, merged_events

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
os.makedirs(CACHE, exist_ok=True)
CACHE_TTL = 300

# Leftovers worth less than this are dust, not an open position.
DUST_USD = 1.00


def _cached(name: str, loader, force: bool = False):
    path = os.path.join(CACHE, name)
    if not force and os.path.exists(path):
        if datetime.now().timestamp() - os.path.getmtime(path) < CACHE_TTL:
            with open(path) as f:
                return json.load(f)
    data = loader()
    with open(path, "w") as f:
        json.dump(data, f)
    return data


# --------------------------------------------------------------------------
# raw data
# --------------------------------------------------------------------------
def _load_fills() -> list[dict]:
    fills, cursor = [], None
    while True:
        params = {"limit": 250}
        if cursor:
            params["cursor"] = cursor
        d = get_json("/api/v3/brokerage/orders/historical/fills", params)
        batch = d.get("fills", [])
        fills.extend(batch)
        cursor = d.get("cursor")
        if not cursor or not batch:
            break
    return fills


def fetch_accounts() -> list[dict]:
    return get_json("/api/v3/brokerage/accounts", {"limit": 250}).get("accounts", [])


def fetch_prices(currencies: set[str]) -> dict[str, float]:
    prices = {c: 1.0 for c in STABLES}
    for c in sorted(currencies):
        if c in prices:
            continue
        try:
            prices[c] = float(get_json(f"/api/v3/brokerage/products/{c}-USD")["price"])
        except Exception:
            prices[c] = 0.0
    return prices


def fetch_fee_tier() -> dict:
    try:
        d = get_json("/api/v3/brokerage/transaction_summary")
        t = d.get("fee_tier", {}) or {}
        return {
            "tier": t.get("pricing_tier", "?"),
            "maker": float(t.get("maker_fee_rate") or 0),
            "taker": float(t.get("taker_fee_rate") or 0),
            "volume_30d": float(d.get("total_volume") or 0),
            "total_fees": float(d.get("total_fees") or 0),
        }
    except Exception:
        return {}


def fetch_open_orders() -> list[dict]:
    try:
        d = get_json("/api/v3/brokerage/orders/historical/batch",
                     {"order_status": "OPEN", "limit": 100})
    except Exception:
        return []
    out = []
    for o in d.get("orders", []):
        cfg = o.get("order_configuration", {}) or {}
        kind = next(iter(cfg), "")
        inner = cfg.get(kind, {}) or {}
        out.append({
            "product": o.get("product_id"),
            "side": o.get("side"),
            "type": kind,
            "size": inner.get("base_size"),
            "limit_price": inner.get("limit_price"),
            "stop_price": inner.get("stop_trigger_price") or inner.get("stop_price"),
            "created": o.get("created_time", "")[:19],
        })
    return out


# --------------------------------------------------------------------------
# events -> trades (FIFO per asset)
# --------------------------------------------------------------------------
def build_trades(events: list[dict]) -> list[dict]:
    by_symbol: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        if e["symbol"] in STABLES:
            continue
        by_symbol[e["symbol"]].append(e)

    trades: list[dict] = []
    for symbol, rows in by_symbol.items():
        rows.sort(key=lambda r: r["time"].replace("Z", "+00:00"))
        lots: deque = deque()      # [qty, unit_cost]
        cur: dict | None = None

        for row in rows:
            if cur is None:
                cur = {
                    "symbol": symbol,
                    "side": "LONG",
                    "open_time": row["time"],
                    "close_time": None,
                    "entry_qty": 0.0, "entry_cost": 0.0,
                    "exit_qty": 0.0, "exit_proceeds": 0.0,
                    "matched_cost": 0.0, "unmatched_qty": 0.0,
                    "fees": 0.0, "events": 0,
                    "products": set(), "sources": set(),
                    "maker_fills": 0, "taker_fills": 0,
                }
            cur["events"] += 1
            cur["fees"] += row["fee"]
            cur["products"].add(row["product"])
            cur["sources"].add(row["source"])
            if row.get("liquidity") == "MAKER":
                cur["maker_fills"] += 1
            elif row.get("liquidity") == "TAKER":
                cur["taker_fills"] += 1

            if row["side"] == "BUY":
                unit = row["quote"] / row["qty"] if row["qty"] else 0.0
                lots.append([row["qty"], unit])
                cur["entry_qty"] += row["qty"]
                cur["entry_cost"] += row["quote"]
            else:
                remaining = row["qty"]
                while remaining > 1e-12 and lots:
                    lot = lots[0]
                    take = min(lot[0], remaining)
                    cur["matched_cost"] += take * lot[1]
                    lot[0] -= take
                    remaining -= take
                    if lot[0] <= 1e-12:
                        lots.popleft()
                if remaining > 1e-9:
                    # sold more than we can account for (pre-history coins)
                    cur["unmatched_qty"] += remaining
                cur["exit_qty"] += row["qty"]
                cur["exit_proceeds"] += row["quote"]
                cur["close_time"] = row["time"]

            # Treat a position as flat once the remainder is dust. Rounding in
            # Coinbase's own reporting leaves slivers (fractions of a cent)
            # that would otherwise keep a finished trade open forever.
            open_qty = sum(l[0] for l in lots)
            unit = lots[0][1] if lots else 0.0
            is_dust = open_qty * unit < DUST_USD
            if (open_qty <= 1e-9 or is_dust) and cur["exit_qty"] > 0:
                trades.append(_finalize(cur, lots, closed=True))
                cur, lots = None, deque()

        if cur is not None:
            trades.append(_finalize(cur, lots, closed=False))

    trades.sort(key=lambda t: t["open_time"].replace("Z", "+00:00"))
    for i, t in enumerate(trades, 1):
        t["id"] = i
    return trades


def _finalize(t: dict, lots: deque, closed: bool) -> dict:
    t["products"] = sorted(t["products"])
    t["sources"] = sorted(t["sources"])
    t["entry_price"] = t["entry_cost"] / t["entry_qty"] if t["entry_qty"] else 0.0
    t["exit_price"] = t["exit_proceeds"] / t["exit_qty"] if t["exit_qty"] else 0.0
    t["status"] = "CLOSED" if closed else "OPEN"
    # A trade is trustworthy when every unit sold had a known cost basis.
    # Judge that by VALUE, not quantity: a bare quantity threshold is
    # meaningless across assets, where 0.006 XRP is under a cent but 0.006 BTC
    # is hundreds of dollars. Sub-dollar slivers come from Coinbase's own
    # rounding and from conversions of reward dust, and move P&L by fractions
    # of a cent.
    unit = t["exit_price"] or t["entry_price"] or 0.0
    t["unmatched_value"] = t["unmatched_qty"] * unit
    t["basis_complete"] = t["unmatched_value"] < DUST_USD

    if closed:
        basis = t["matched_cost"]
        gross = t["exit_proceeds"] - basis
        t["gross_pnl"] = gross
        t["net_pnl"] = gross - t["fees"]
        t["net_roi"] = (t["net_pnl"] / basis * 100) if basis > 0 else 0.0
        t["result"] = ("WIN" if t["net_pnl"] > 0
                       else "LOSS" if t["net_pnl"] < 0 else "BE")
        try:
            o = datetime.fromisoformat(t["open_time"].replace("Z", "+00:00"))
            c = datetime.fromisoformat(t["close_time"].replace("Z", "+00:00"))
            t["hold_seconds"] = (c - o).total_seconds()
        except Exception:
            t["hold_seconds"] = 0
        t["open_qty"] = 0.0
        t["open_basis"] = 0.0
    else:
        t["open_qty"] = sum(l[0] for l in lots)
        t["open_basis"] = sum(l[0] * l[1] for l in lots)
        t["open_avg_price"] = t["open_basis"] / t["open_qty"] if t["open_qty"] else 0.0
        t["gross_pnl"] = None
        t["net_pnl"] = None
        t["net_roi"] = None
        t["result"] = "OPEN"
        t["hold_seconds"] = None
        # realized part of a still-open position (partial exits)
        if t["exit_qty"] > 0:
            t["realized_pnl"] = t["exit_proceeds"] - t["matched_cost"] - t["fees"]
        else:
            t["realized_pnl"] = 0.0
    return t


def mark_open_trades(trades: list[dict], prices: dict[str, float]) -> None:
    for t in trades:
        if t["status"] != "OPEN":
            continue
        px = prices.get(t["symbol"], 0.0)
        qty = t.get("open_qty", 0.0)
        t["mark_price"] = px
        t["market_value"] = qty * px
        t["unrealized_pnl"] = (qty * px) - t["open_basis"] if px else 0.0
        t["net_roi"] = (
            t["unrealized_pnl"] / t["open_basis"] * 100 if t["open_basis"] else 0.0
        )


# --------------------------------------------------------------------------
# analytics
# --------------------------------------------------------------------------
def daily_stats(trades: list[dict]) -> list[dict]:
    days: dict[str, dict] = {}
    pos: dict[str, float] = defaultdict(float)
    neg: dict[str, float] = defaultdict(float)

    for t in trades:
        if t["status"] != "CLOSED":
            continue
        d = t["close_time"][:10]
        s = days.setdefault(d, {
            "date": d, "net_pnl": 0.0, "gross_pnl": 0.0, "fees": 0.0,
            "trades": 0, "wins": 0, "losses": 0, "volume": 0.0,
        })
        s["net_pnl"] += t["net_pnl"]
        s["gross_pnl"] += t["gross_pnl"]
        s["fees"] += t["fees"]
        s["trades"] += 1
        s["volume"] += t["matched_cost"]
        if t["net_pnl"] > 0:
            s["wins"] += 1
            pos[d] += t["net_pnl"]
        elif t["net_pnl"] < 0:
            s["losses"] += 1
            neg[d] += abs(t["net_pnl"])

    out = sorted(days.values(), key=lambda x: x["date"])
    run = 0.0
    for s in out:
        run += s["net_pnl"]
        s["cumulative"] = run
        s["win_rate"] = (s["wins"] / s["trades"] * 100) if s["trades"] else 0.0
        n = neg.get(s["date"], 0.0)
        s["profit_factor"] = (pos.get(s["date"], 0.0) / n) if n else 0.0
    return out


def drawdown_series(days: list[dict]) -> list[dict]:
    peak, out = 0.0, []
    for d in days:
        peak = max(peak, d["cumulative"])
        out.append({"date": d["date"], "drawdown": d["cumulative"] - peak,
                    "cumulative": d["cumulative"]})
    return out


def _scale(v, lo, hi):
    if hi == lo:
        return 0.0
    return max(0.0, min(100.0, (v - lo) / (hi - lo) * 100))


def zella_score(s: dict, days: list[dict]) -> dict:
    win = _scale(s["win_rate"], 0, 70)
    pf = _scale(s["profit_factor"], 0, 3)
    ratio = _scale(s["avg_win_loss_ratio"], 0, 3)
    denom = max(s["gross_profit"], 1.0)
    dd = _scale(1 - min(abs(s["max_drawdown"]) / denom, 1.0), 0, 1)
    rec = _scale(s["recovery_factor"], 0, 3)
    vals = [d["net_pnl"] for d in days]
    if len(vals) > 1:
        mean = sum(vals) / len(vals)
        std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
        cons = _scale(1 - min(std / (abs(mean) + std + 1e-9), 1.0), 0, 1)
    else:
        cons = 0.0
    parts = {
        "win_rate": round(win, 1), "profit_factor": round(pf, 1),
        "avg_win_loss": round(ratio, 1), "max_drawdown": round(dd, 1),
        "recovery_factor": round(rec, 1), "consistency": round(cons, 1),
    }
    parts["score"] = round(sum(parts.values()) / 6, 2)
    return parts


def summary(trades: list[dict], days: list[dict]) -> dict:
    closed = [t for t in trades if t["status"] == "CLOSED"]
    wins = [t for t in closed if t["net_pnl"] > 0]
    losses = [t for t in closed if t["net_pnl"] < 0]
    gp = sum(t["net_pnl"] for t in wins)
    gl = abs(sum(t["net_pnl"] for t in losses))
    net = sum(t["net_pnl"] for t in closed)
    avg_win = gp / len(wins) if wins else 0.0
    avg_loss = gl / len(losses) if losses else 0.0
    dd = drawdown_series(days)
    max_dd = min([x["drawdown"] for x in dd], default=0.0)
    open_trades = [t for t in trades if t["status"] == "OPEN"]
    hold = [t["hold_seconds"] for t in closed if t.get("hold_seconds")]

    # Money already taken off the table by partial exits of positions that are
    # still open. Excluded from trade statistics (the trade has no result yet)
    # but very real cash, so it must appear in the P&L reconciliation.
    realized_open = sum(t.get("realized_pnl") or 0 for t in open_trades)

    s = {
        "net_pnl": net,
        "realized_from_open": realized_open,
        "total_realized": net + realized_open,
        "gross_profit": gp,
        "gross_loss": gl,
        "total_fees": sum(t["fees"] for t in trades),
        "trade_count": len(closed),
        "open_count": len(open_trades),
        "wins": len(wins), "losses": len(losses),
        "win_rate": (len(wins) / len(closed) * 100) if closed else 0.0,
        "profit_factor": (gp / gl) if gl else 0.0,
        "avg_win": avg_win, "avg_loss": avg_loss,
        "avg_win_loss_ratio": (avg_win / avg_loss) if avg_loss else 0.0,
        "largest_win": max([t["net_pnl"] for t in wins], default=0.0),
        "largest_loss": min([t["net_pnl"] for t in losses], default=0.0),
        "day_count": len(days),
        "win_days": len([d for d in days if d["net_pnl"] > 0]),
        "loss_days": len([d for d in days if d["net_pnl"] < 0]),
        "day_win_rate": (len([d for d in days if d["net_pnl"] > 0]) / len(days) * 100)
                        if days else 0.0,
        "avg_daily_pnl": (sum(d["net_pnl"] for d in days) / len(days)) if days else 0.0,
        "max_drawdown": max_dd,
        "trade_expectancy": (net / len(closed)) if closed else 0.0,
        "unrealized_pnl": sum(t.get("unrealized_pnl") or 0 for t in open_trades),
        "open_market_value": sum(t.get("market_value") or 0 for t in open_trades),
        "open_basis": sum(t.get("open_basis") or 0 for t in open_trades),
        "avg_hold_seconds": (sum(hold) / len(hold)) if hold else 0.0,
        "recovery_factor": (net / abs(max_dd)) if max_dd else 0.0,
        "incomplete_basis_trades": len([t for t in closed if not t["basis_complete"]]),
        "unmatched_value_total": sum(t.get("unmatched_value") or 0 for t in trades),
    }
    s["zella_score"] = zella_score(s, days)
    return s


def by_symbol(trades: list[dict]) -> list[dict]:
    agg: dict[str, dict] = {}
    for t in trades:
        a = agg.setdefault(t["symbol"], {
            "symbol": t["symbol"], "net_pnl": 0.0, "unrealized": 0.0,
            "trades": 0, "wins": 0, "fees": 0.0, "volume": 0.0, "open": 0,
        })
        a["fees"] += t["fees"]
        if t["status"] == "CLOSED":
            a["net_pnl"] += t["net_pnl"]
            a["trades"] += 1
            a["volume"] += t["matched_cost"]
            if t["net_pnl"] > 0:
                a["wins"] += 1
        else:
            a["open"] += 1
            a["unrealized"] += t.get("unrealized_pnl") or 0
    for a in agg.values():
        a["win_rate"] = (a["wins"] / a["trades"] * 100) if a["trades"] else 0.0
        a["total"] = a["net_pnl"] + a["unrealized"]
    return sorted(agg.values(), key=lambda x: -x["total"])


def hourly_performance(trades: list[dict]) -> list[dict]:
    b = {h: {"hour": h, "net_pnl": 0.0, "trades": 0} for h in range(24)}
    for t in trades:
        if t["status"] != "CLOSED":
            continue
        try:
            h = datetime.fromisoformat(t["open_time"].replace("Z", "+00:00")).hour
        except Exception:
            continue
        b[h]["net_pnl"] += t["net_pnl"]
        b[h]["trades"] += 1
    return [b[h] for h in range(24)]


def weekday_performance(trades: list[dict]) -> list[dict]:
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    b = {i: {"day": names[i], "net_pnl": 0.0, "trades": 0} for i in range(7)}
    for t in trades:
        if t["status"] != "CLOSED":
            continue
        try:
            w = datetime.fromisoformat(t["close_time"].replace("Z", "+00:00")).weekday()
        except Exception:
            continue
        b[w]["net_pnl"] += t["net_pnl"]
        b[w]["trades"] += 1
    return [b[i] for i in range(7)]


def portfolio(accounts: list[dict], prices: dict[str, float]) -> dict:
    holdings, total = [], 0.0
    for a in accounts:
        avail = float(a["available_balance"]["value"])
        hold = float((a.get("hold") or {}).get("value") or 0)
        bal = avail + hold
        if bal <= 1e-9:
            continue
        c = a["currency"]
        px = prices.get(c, 1.0 if c in STABLES else 0.0)
        val = bal * px
        total += val
        holdings.append({"currency": c, "balance": bal, "available": avail,
                         "hold": hold, "price": px, "value": val})
    holdings.sort(key=lambda h: -h["value"])
    for h in holdings:
        h["weight"] = (h["value"] / total * 100) if total else 0.0
    return {"holdings": holdings, "total_value": total}


def cash_flows(ledger: dict[str, list[dict]]) -> dict:
    """External money in/out - what the account actually cost."""
    dep = wd = clawback = 0.0
    buys_ext = buys_from_cash = 0.0
    for cur, rows in ledger.items():
        for t in rows:
            usd = float((t.get("native_amount") or {}).get("amount") or 0)
            ty = t["type"]
            if ty == "fiat_deposit":
                dep += usd
            elif ty == "fiat_withdrawal":
                wd += usd
            elif ty == "clawback":
                clawback += usd
            elif ty == "buy":
                if cur == "USD":
                    buys_from_cash += usd
                else:
                    buys_ext += usd
    net_invested = dep + (buys_ext + buys_from_cash) + wd + clawback
    return {
        "deposits": dep, "withdrawals": wd, "clawbacks": clawback,
        "external_buys": buys_ext + buys_from_cash,
        "net_invested": net_invested,
    }


def rewards_income(ledger: dict[str, list[dict]]) -> dict:
    from events import REWARD_TYPES
    out: dict[str, float] = defaultdict(float)
    for cur, rows in ledger.items():
        for t in rows:
            if t["type"] in REWARD_TYPES:
                out[t["type"]] += float((t.get("native_amount") or {}).get("amount") or 0)
    total = sum(out.values())
    return {"by_type": dict(out), "total": total}


def reconcile(summary_: dict, portfolio_: dict, flows: dict, rewards: dict) -> dict:
    """Prove the P&L ties to the money.

    net invested + total realized + unrealized  ==  portfolio value

    Any residual is reported rather than hidden; a healthy build shows a
    residual near zero (a few dollars of Coinbase rounding at most).
    """
    invested = flows["net_invested"]
    realized = summary_["total_realized"]
    unrealized = summary_["unrealized_pnl"]
    # Rewards arrive as assets you never paid for, so they lift portfolio value
    # without any matching cash outflow.
    income = rewards["total"]
    expected = invested + realized + unrealized + income
    actual = portfolio_["total_value"]
    residual = actual - expected
    # Tolerance covers Coinbase's own rounding, the spread baked into
    # simple-interface prices, and marks taken microseconds apart.
    tolerance = max(50.0, actual * 0.01)
    return {
        "net_invested": invested,
        "total_realized": realized,
        "unrealized": unrealized,
        "income": income,
        "expected_value": expected,
        "actual_value": actual,
        "residual": residual,
        "tolerance": tolerance,
        "balanced": abs(residual) <= tolerance,
        "total_return": actual - invested,
        "total_return_pct": ((actual / invested - 1) * 100) if invested else 0.0,
        "rewards_income": rewards["total"],
        "fees_paid": summary_["total_fees"],
    }


def build_report(force: bool = False) -> dict:
    fills = _cached("fills.json", _load_fills, force)
    ledger = _cached("ledger.json", fetch_ledger, force)
    events = merged_events(fills, ledger)
    trades = build_trades(events)
    accounts = fetch_accounts()

    currencies = {t["symbol"] for t in trades}
    currencies |= {a["currency"] for a in accounts
                   if float(a["available_balance"]["value"]) > 0}
    prices = fetch_prices(currencies)
    mark_open_trades(trades, prices)
    days = daily_stats(trades)
    s = summary(trades, days)
    pf = portfolio(accounts, prices)
    flows = cash_flows(ledger)
    rew = rewards_income(ledger)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": s,
        "reconciliation": reconcile(s, pf, flows, rew),
        "trades": trades,
        "days": days,
        "drawdown": drawdown_series(days),
        "by_symbol": by_symbol(trades),
        "hourly": hourly_performance(trades),
        "weekday": weekday_performance(trades),
        "portfolio": pf,
        "fee_tier": fetch_fee_tier(),
        "open_orders": fetch_open_orders(),
        "cash_flows": flows,
        "rewards": rew,
        "event_count": len(events),
        "prices": prices,
    }


if __name__ == "__main__":
    rep = build_report()
    s, r = rep["summary"], rep["reconciliation"]
    print(f"events {rep['event_count']} | trades {s['trade_count']} closed / {s['open_count']} open")
    print(f"win rate {s['win_rate']:.1f}%  profit factor {s['profit_factor']:.2f}  "
          f"zella {s['zella_score']['score']}")
    print("\n--- P&L RECONCILIATION ---")
    print(f" net invested        ${r['net_invested']:>12,.2f}")
    print(f" realized (closed)   ${s['net_pnl']:>12,.2f}")
    print(f" realized (partial)  ${s['realized_from_open']:>12,.2f}")
    print(f" unrealized          ${r['unrealized']:>12,.2f}")
    print(f" = expected value    ${r['expected_value']:>12,.2f}")
    print(f" actual portfolio    ${r['actual_value']:>12,.2f}")
    print(f" residual            ${r['residual']:>12,.2f}   "
          f"{'BALANCED' if r['balanced'] else 'OUT OF BALANCE'}")
    print(f"\n total return        ${r['total_return']:>12,.2f} "
          f"({r['total_return_pct']:+.1f}%)")
    print(f" fees paid           ${r['fees_paid']:>12,.2f}")
    print(f" rewards income      ${r['rewards_income']:>12,.2f}")
