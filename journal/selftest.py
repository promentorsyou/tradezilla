"""Independent re-derivation of the journal's numbers.

The point of this module is to *disagree* with engine.py when engine.py is
wrong. It therefore recomputes P&L from the raw Coinbase records through its
own FIFO walk rather than calling into the engine, so a bug in the engine
cannot hide by being reused on both sides of the comparison.

Run standalone:

    python selftest.py            # rebuild from Coinbase and check
    python selftest.py --quiet    # only report failures

Or via daily_update.py, which refuses to publish when any check fails.
"""
from __future__ import annotations

import math
from collections import defaultdict, deque
from decimal import Decimal, getcontext

getcontext().prec = 40      # far beyond float; the arbiter must not itself drift

TOL = 0.01          # a cent, for figures the engine simply copies around

# The independent walk below is exact (Decimal), so the only error in a
# comparison is the engine's own float accumulation. Chained FIFO relief over
# ~100 fills drifts a cent or two on a five-figure total, which is arithmetic
# reality rather than a defect. This bound absorbs that and still fails on any
# discrepancy big enough to matter - a dropped fee or a missing trade is
# hundreds of dollars, four orders of magnitude above it.
def float_tol(value: float) -> float:
    return max(0.05, abs(value) * 1e-5)


class Check:
    def __init__(self, name: str):
        self.name = name
        self.failures: list[str] = []
        self.detail = ""

    def fail(self, msg: str) -> None:
        self.failures.append(msg)

    @property
    def ok(self) -> bool:
        return not self.failures


# --------------------------------------------------------------------------
# independent recomputation
# --------------------------------------------------------------------------
def independent_trades(events: list[dict], rebates: dict[str, float],
                       stables: set[str]) -> dict[str, dict]:
    """Walk the events again, separately, and total P&L per asset.

    Deliberately simpler than the engine: no round-trip grouping, no dust
    handling, no open/closed split - just FIFO cost relief per asset. If the
    engine's much richer bookkeeping is right, its realized totals must equal
    these.

    Computed in Decimal, so this side carries no rounding error of its own and
    can act as the arbiter: any gap is the engine's float drift, measured
    against exact arithmetic rather than against another approximation.
    """
    D = Decimal
    ZERO, EPS = D(0), D("1e-12")
    lots: dict[str, deque] = defaultdict(deque)
    realized: dict[str, Decimal] = defaultdict(lambda: ZERO)
    fees: dict[str, Decimal] = defaultdict(lambda: ZERO)
    rebate: dict[str, Decimal] = defaultdict(lambda: ZERO)

    for e in sorted(events, key=lambda x: x["time"].replace("Z", "+00:00")):
        sym = e["symbol"]
        if sym in stables:
            continue
        fee = D(str(e["fee"]))
        fees[sym] += fee
        if e["fee"]:
            rebate[sym] += fee * D(str(rebates.get(e["time"][:10], 0.0)))

        q, v = D(str(e["qty"])), D(str(e["quote"]))
        if e["side"] == "BUY":
            lots[sym].append([q, (v / q) if q else ZERO])
        else:
            remaining, cost = q, ZERO
            while remaining > EPS and lots[sym]:
                lot = lots[sym][0]
                take = min(lot[0], remaining)
                cost += take * lot[1]
                lot[0] -= take
                remaining -= take
                if lot[0] <= EPS:
                    lots[sym].popleft()
            realized[sym] += v - cost

    return {sym: {"realized_gross": float(realized[sym]), "fees": float(fees[sym]),
                  "rebate": float(rebate[sym]),
                  "open_qty": float(sum((q for q, _ in lots[sym]), ZERO)),
                  "open_basis": float(sum((q * u for q, u in lots[sym]), ZERO))}
            for sym in set(list(realized) + list(fees) + list(lots))}


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------
def check_pnl_independently(report, events, rebates, stables) -> Check:
    c = Check("P&L re-derived from raw fills")
    indep = independent_trades(events, rebates, stables)

    eng: dict[str, dict] = defaultdict(lambda: {"gross": 0.0, "fees": 0.0,
                                                "rebate": 0.0, "basis": 0.0})
    for t in report["trades"]:
        a = eng[t["symbol"]]
        a["fees"] += t["fees"]
        a["rebate"] += t["fee_rebate"]
        if t["status"] == "CLOSED":
            a["gross"] += t["gross_pnl"]
        else:
            a["basis"] += t["open_basis"]
            if t["exit_qty"] > 0:
                a["gross"] += t["exit_proceeds"] - t["matched_cost"]

    for sym in sorted(set(indep) | set(eng)):
        i, e = indep.get(sym, {}), eng.get(sym, {})
        for label, a, b in (
            ("gross realized", e.get("gross", 0.0), i.get("realized_gross", 0.0)),
            ("fees", e.get("fees", 0.0), i.get("fees", 0.0)),
            ("rebate", e.get("rebate", 0.0), i.get("rebate", 0.0)),
            ("open basis", e.get("basis", 0.0), i.get("open_basis", 0.0)),
        ):
            if abs(a - b) > float_tol(b):
                c.fail(f"{sym} {label}: engine ${a:,.2f} vs independent ${b:,.2f} "
                       f"(off ${a-b:+,.2f})")
    c.detail = f"{len(indep)} assets re-derived"
    return c


def check_totals_add_up(report) -> Check:
    """Summary figures must equal the trades they claim to summarise."""
    c = Check("summary equals the sum of its trades")
    s = report["summary"]
    closed = [t for t in report["trades"] if t["status"] == "CLOSED"]
    open_ = [t for t in report["trades"] if t["status"] == "OPEN"]

    pairs = [
        ("net_pnl", s["net_pnl"], sum(t["net_pnl"] for t in closed)),
        ("realized_from_open", s["realized_from_open"],
         sum(t.get("realized_pnl") or 0 for t in open_)),
        ("gross_fees", s["gross_fees"], sum(t["fees"] for t in report["trades"])),
        ("fee_rebates", s["fee_rebates"],
         sum(t["fee_rebate"] for t in report["trades"])),
        ("unrealized", s["unrealized_pnl"],
         sum(t.get("unrealized_pnl") or 0 for t in open_)),
        ("wins", s["wins"], len([t for t in closed if t["net_pnl"] > 0])),
        ("trade_count", s["trade_count"], len(closed)),
    ]
    for name, claimed, actual in pairs:
        if abs(claimed - actual) > TOL:
            c.fail(f"{name}: summary {claimed:,.2f} vs trades {actual:,.2f}")

    # every trade's own arithmetic
    for t in closed:
        want = t["gross_pnl"] - (t["fees"] - t["fee_rebate"])
        if abs(t["net_pnl"] - want) > TOL:
            c.fail(f"trade #{t['id']} {t['symbol']}: net_pnl {t['net_pnl']:,.2f} "
                   f"!= gross {t['gross_pnl']:,.2f} - net fee {t['fees']-t['fee_rebate']:,.2f}")
        if abs(t["gross_pnl"] - (t["exit_proceeds"] - t["matched_cost"])) > TOL:
            c.fail(f"trade #{t['id']} gross_pnl does not equal proceeds - cost basis")
    c.detail = f"{len(closed)} closed, {len(open_)} open"
    return c


def check_daily_rollup(report) -> Check:
    """Daily P&L must reconcile to the trades that closed on each day."""
    c = Check("daily totals match their trades")
    per_day: dict[str, float] = defaultdict(float)
    per_day_n: dict[str, int] = defaultdict(int)
    for t in report["trades"]:
        if t["status"] == "CLOSED":
            per_day[t["close_time"][:10]] += t["net_pnl"]
            per_day_n[t["close_time"][:10]] += 1
    for d in report["days"]:
        if abs(d["net_pnl"] - per_day[d["date"]]) > TOL:
            c.fail(f"{d['date']}: day says {d['net_pnl']:,.2f}, "
                   f"trades say {per_day[d['date']]:,.2f}")
        if d["trades"] != per_day_n[d["date"]]:
            c.fail(f"{d['date']}: day counts {d['trades']} trades, found {per_day_n[d['date']]}")
    run = 0.0
    for d in report["days"]:
        run += d["net_pnl"]
        if abs(d["cumulative"] - run) > TOL:
            c.fail(f"{d['date']}: cumulative {d['cumulative']:,.2f} != running {run:,.2f}")
            break
    c.detail = f"{len(report['days'])} days"
    return c


def check_rebate_against_ledger(report, ledger) -> Check:
    """Credited rebates must equal what Coinbase actually paid."""
    c = Check("rebate credited equals the ledger")
    paid = sum(float((t.get("native_amount") or {}).get("amount") or 0)
               for rows in ledger.values() for t in rows
               if t["type"] == "subscription_rebate")
    credited = report["summary"]["fee_rebates"]
    if paid and abs(paid - credited) > max(1.0, paid * 0.02):
        c.fail(f"ledger paid ${paid:,.2f}, journal credited ${credited:,.2f} "
               f"(off ${credited-paid:+,.2f})")
    gross = report["summary"]["gross_fees"]
    if credited > gross + TOL:
        c.fail(f"rebate ${credited:,.2f} exceeds gross fees ${gross:,.2f}")
    c.detail = (f"${credited:,.2f} credited, ${paid:,.2f} in ledger"
                + (f" ({credited/gross*100:.2f}% of fees)" if gross else ""))
    return c


def check_positions(report, accounts, stables) -> Check:
    """FIFO positions must equal the balances Coinbase reports."""
    c = Check("positions match Coinbase balances")
    actual = {}
    for a in accounts:
        bal = (float(a["available_balance"]["value"])
               + float((a.get("hold") or {}).get("value") or 0))
        if bal > 1e-9:
            actual[a["currency"]] = bal
    fifo: dict[str, float] = defaultdict(float)
    for t in report["trades"]:
        if t["status"] == "OPEN":
            fifo[t["symbol"]] += t["open_qty"]
    for sym in set(fifo) | {k for k in actual if k not in stables}:
        drift = abs(fifo.get(sym, 0.0) - actual.get(sym, 0.0))
        usd = drift * report["prices"].get(sym, 0.0)
        if usd >= 1.0:
            c.fail(f"{sym}: journal {fifo.get(sym,0):.8f} vs Coinbase "
                   f"{actual.get(sym,0):.8f} (${usd:,.2f})")
    c.detail = f"{len(fifo)} open positions"
    return c


def check_reconciliation(report) -> Check:
    c = Check("money in equals money now")
    r = report["reconciliation"]
    if not r["balanced"]:
        c.fail(f"residual ${r['residual']:,.2f} exceeds tolerance ${r['tolerance']:,.2f}")
    lhs = (r["net_invested"] + r["total_realized"] + r["unrealized"] + r["income"]
           - r.get("open_position_fees", 0.0) + r.get("open_position_rebate", 0.0))
    if abs(lhs - r["expected_value"]) > TOL:
        c.fail(f"expected_value {r['expected_value']:,.2f} != its own components {lhs:,.2f}")
    c.detail = (f"residual ${r['residual']:,.2f} "
                f"({abs(r['residual'])/max(r['actual_value'],1)*100:.3f}%)")
    return c


def check_sane_values(report) -> Check:
    c = Check("no missing or absurd values")
    for t in report["trades"]:
        for k in ("entry_price", "exit_price", "net_roi", "net_pnl",
                  "unrealized_pnl", "fees", "fee_rebate"):
            v = t.get(k)
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                c.fail(f"trade #{t['id']} {k} is {v}")
        if t["status"] == "CLOSED":
            if t["net_pnl"] is None:
                c.fail(f"trade #{t['id']} closed with no net_pnl")
            if t.get("net_roi") is not None and abs(t["net_roi"]) > 1000:
                c.fail(f"trade #{t['id']} {t['symbol']} ROI {t['net_roi']:,.0f}%")
            if t["fee_rebate"] > t["fees"] + TOL:
                c.fail(f"trade #{t['id']} rebate exceeds its own fee")
        if t["fees"] < -TOL or t["fee_rebate"] < -TOL:
            c.fail(f"trade #{t['id']} has a negative fee or rebate")
    if report["summary"]["incomplete_basis_trades"]:
        c.fail(f"{report['summary']['incomplete_basis_trades']} trades lack cost basis")
    c.detail = f"{len(report['trades'])} trades scanned"
    return c


# --------------------------------------------------------------------------
# runner
# --------------------------------------------------------------------------
def run_all(report, *, events=None, ledger=None, accounts=None,
            rebates=None, stables=None) -> list[Check]:
    import engine
    from events import STABLES, merged_events

    stables = stables or STABLES
    if ledger is None:
        ledger = engine._cached("ledger.json", engine.fetch_ledger)
    if events is None:
        fills = engine._cached("fills.json", engine._load_fills)
        events = merged_events(fills, ledger)
    if rebates is None:
        rebates = engine.rebate_rate_by_day(ledger, events)
    if accounts is None:
        accounts = engine.fetch_accounts()

    return [
        check_pnl_independently(report, events, rebates, stables),
        check_totals_add_up(report),
        check_daily_rollup(report),
        check_rebate_against_ledger(report, ledger),
        check_positions(report, accounts, stables),
        check_reconciliation(report),
        check_sane_values(report),
    ]


def report_checks(checks: list[Check], quiet: bool = False) -> bool:
    passed = [c for c in checks if c.ok]
    failed = [c for c in checks if not c.ok]
    if not quiet:
        for c in checks:
            mark = "PASS" if c.ok else "FAIL"
            print(f"  [{mark}] {c.name}" + (f"  ({c.detail})" if c.detail else ""))
            for f in c.failures:
                print(f"         - {f}")
    elif failed:
        for c in failed:
            print(f"  [FAIL] {c.name}")
            for f in c.failures:
                print(f"         - {f}")
    print(f"  {len(passed)}/{len(checks)} checks passed")
    return not failed


if __name__ == "__main__":
    import sys
    import engine
    quiet = "--quiet" in sys.argv
    print("rebuilding from Coinbase ...")
    rep = engine.build_report(force=True)
    print("verifying ...")
    ok = report_checks(run_all(rep), quiet)
    raise SystemExit(0 if ok else 1)
