"""One command that refreshes the whole journal from Coinbase.

    python daily_update.py                 # pull, rebuild, verify, publish
    python daily_update.py --no-push       # everything except git push
    python daily_update.py --scaled        # publish with dollar amounts rescaled
    python daily_update.py --check-only    # verify the data, change nothing

What it does, in order:

  1. pulls every fill and ledger entry from Coinbase (read-only)
  2. rebuilds round-trip trades, FIFO, per asset
  3. measures the Coinbase One rebate rate actually observed and credits it
     back to the trades that paid the fees, so P&L is net of what fees really
     cost
  4. runs integrity checks and refuses to publish if any fail
  5. writes the static site and copies it into docs/
  6. commits and pushes, which redeploys GitHub Pages

Designed to be safe to run on a schedule: it never places an order, and it
aborts rather than publishing numbers that do not reconcile.
"""
from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES_REPO = os.environ.get("TRADEZILLA_REPO", "/workspace/tradezilla")

def forbidden_strings() -> list[str]:
    """Secrets that must never appear in a published build.

    Derived from the live credentials rather than hard-coded: writing key
    fragments into this file would itself leak them the moment the repo is
    public, which is exactly what the check exists to prevent.
    """
    out: list[str] = ["BEGIN EC PRIVATE KEY", "COINBASE_API_PRIVATE_KEY="]
    # Fixed words in the key path carry no secret; guarding them would fire on
    # any build that merely mentions them.
    generic = {"organizations", "apiKeys"}
    key = os.environ.get("COINBASE_API_KEY_NAME", "")
    if key:
        out.append(key)
        # guard each id in the path separately so a partial leak is still caught
        out += [p for p in key.split("/") if len(p) >= 8 and p not in generic]
    pem = os.environ.get("COINBASE_API_PRIVATE_KEY", "")
    for line in pem.replace("\\n", "\n").splitlines():
        line = line.strip()
        if line and "-----" not in line and len(line) >= 20:
            out.append(line)
    return out


def log(msg: str = "") -> None:
    print(msg, flush=True)


def run(cmd: list[str], cwd: str) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


# --------------------------------------------------------------------------
# 1-3. pull and rebuild
# --------------------------------------------------------------------------
def refresh() -> tuple[dict, dict]:
    import engine
    log("→ pulling fills and ledger from Coinbase ...")
    report, context = engine.build_report_bundle(force=True)
    s, rec = report["summary"], report["reconciliation"]
    tier = report.get("fee_tier", {})
    log(f"  {s['trade_count']} closed trades, {s['open_count']} open, "
        f"{report['event_count']} events")
    log(f"  gross fees ${s['gross_fees']:,.2f} − rebate ${s['fee_rebates']:,.2f} "
        f"= net ${s['total_fees']:,.2f}")
    log(f"  fee tier {tier.get('tier', '?')} | "
        f"maker {tier.get('maker', 0) * 100:.4f}% | "
        f"taker {tier.get('taker', 0) * 100:.4f}%")
    log(f"  portfolio ${rec['actual_value']:,.2f} | "
        f"return ${rec['total_return']:+,.2f} ({rec['total_return_pct']:+.2f}%)")
    return report, context


# --------------------------------------------------------------------------
# 4. integrity checks - publishing is blocked unless these pass
# --------------------------------------------------------------------------
def verify(report: dict, context: dict) -> list[str]:
    import engine
    s, rec = report["summary"], report["reconciliation"]
    fails: list[str] = []

    if not rec["balanced"]:
        fails.append(f"reconciliation off by ${rec['residual']:,.2f} "
                     f"(tolerance ${rec['tolerance']:,.2f})")

    # FIFO positions must equal what Coinbase says you hold
    actual = {}
    for a in context["accounts"]:
        bal = (float(a["available_balance"]["value"])
               + float((a.get("hold") or {}).get("value") or 0))
        if bal > 1e-9:
            actual[a["currency"]] = bal
    fifo: dict[str, float] = {}
    for t in report["trades"]:
        if t["status"] == "OPEN":
            fifo[t["symbol"]] = fifo.get(t["symbol"], 0.0) + t["open_qty"]
    for sym in set(fifo) | {c for c in actual if c not in engine.STABLES}:
        drift = abs(fifo.get(sym, 0.0) - actual.get(sym, 0.0)) * \
            report["prices"].get(sym, 0.0)
        if drift >= 1.0:
            fails.append(f"{sym} position off by ${drift:,.2f} vs Coinbase")

    if s["incomplete_basis_trades"]:
        fails.append(f"{s['incomplete_basis_trades']} trades missing cost basis")

    # Never assume a fixed Coinbase tier. The current transaction-summary
    # rates drive live exit/breakeven projections and must be present on every
    # publish, so a VIP 2 -> VIP 3 change is picked up automatically.
    tier = report.get("fee_tier") or {}
    if not tier.get("tier") or tier.get("tier") == "?":
        fails.append("Coinbase fee tier could not be confirmed")
    for name in ("maker", "taker"):
        rate = tier.get(name)
        if not isinstance(rate, (int, float)) or not 0 <= rate <= 0.1:
            fails.append(f"Coinbase {name} fee rate is invalid: {rate!r}")

    for t in report["trades"]:
        for k in ("entry_price", "exit_price", "net_roi", "net_pnl"):
            v = t.get(k)
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                fails.append(f"trade #{t['id']} has invalid {k}")
        if t.get("net_roi") is not None and abs(t["net_roi"]) > 1000:
            fails.append(f"trade #{t['id']} implausible ROI {t['net_roi']:.0f}%")

    # the rebate must be fully accounted for, never invented
    claimed = s["fee_rebates"]
    ledger_total = report["rewards"].get("fee_rebates", 0.0)
    if ledger_total and abs(claimed - ledger_total) > max(1.0, ledger_total * 0.02):
        fails.append(f"rebate credited (${claimed:,.2f}) does not match the "
                     f"ledger (${ledger_total:,.2f})")
    return fails


# --------------------------------------------------------------------------
# 5-6. publish
# --------------------------------------------------------------------------
def publish(report: dict, scaled: bool, push: bool) -> bool:
    import export_static

    log("→ building static site ...")
    os.makedirs(export_static.DIST, exist_ok=True)
    built = os.path.join(HERE, "dist", "demo.html" if scaled else "index.html")
    output_report = report
    if scaled:
        invested = report["cash_flows"]["net_invested"] or 1
        output_report = export_static.scale_report(report, 25000.0 / invested)
    html = export_static.build(output_report, demo=scaled)
    with open(built, "w", encoding="utf-8") as f:
        f.write(html)
    if not os.path.exists(built):
        log(f"  ! expected build missing: {built}")
        return False

    leaked = [p for p in forbidden_strings() if p in html]
    if leaked:
        log(f"  ! ABORT - credentials found in build: {leaked}")
        return False
    log(f"  build clean, {len(html)//1024} KB")

    docs = os.path.join(PAGES_REPO, "docs")
    if not os.path.isdir(docs):
        log(f"  ! {docs} not found - skipping publish")
        return False
    target = os.path.join(docs, "index.html")
    if os.path.exists(target):
        with open(target, encoding="utf-8") as f:
            if f.read() == html:
                log("  published page already current - nothing to push")
                return True
    shutil.copyfile(built, target)

    if not push:
        log("  copied into docs/ (push skipped)")
        return True

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    for cmd in (["git", "add", "docs/index.html"],
                ["git", "-c", "user.email=promentorsyou@gmail.com",
                 "-c", "user.name=ProMentorsYou",
                 "commit", "-q", "-m", f"Daily journal refresh {stamp}"],
                ["git", "push", "-q", "origin", "main"]):
        code, out = run(cmd, PAGES_REPO)
        if code and "nothing to commit" not in out:
            log(f"  ! git failed: {' '.join(cmd)}\n{out}")
            return False
    log("  pushed - GitHub Pages redeploys in about a minute")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-push", action="store_true", help="build but do not push")
    ap.add_argument("--scaled", action="store_true",
                    help="publish with dollar amounts rescaled")
    ap.add_argument("--check-only", action="store_true",
                    help="verify the data and exit without publishing")
    args = ap.parse_args()

    log(f"=== journal update {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC} ===")
    try:
        report, context = refresh()
    except Exception as exc:
        log(f"! could not reach Coinbase: {type(exc).__name__}: {exc}")
        log("  check COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY")
        return 2

    log("→ verifying ...")
    fails = verify(report, context)
    if fails:
        log("  FAILED:")
        for f in fails:
            log(f"    - {f}")
        log("  refusing to publish numbers that do not check out")
        return 1
    rec = report["reconciliation"]
    log(f"  all checks pass (residual ${rec['residual']:,.2f}, "
        f"{abs(rec['residual'])/max(rec['actual_value'],1)*100:.3f}%)")

    # A second implementation recomputes P&L, fee/rebate attribution, daily
    # totals and positions from the same Coinbase snapshot. It makes no new
    # network calls and prevents a moving market from creating false drift.
    import selftest
    log("→ independent audit ...")
    if not selftest.report_checks(selftest.run_all(report, **context)):
        log("  refusing to publish numbers that do not check out")
        return 1

    if args.check_only:
        log("→ check-only, nothing published")
        return 0

    return 0 if publish(report, args.scaled, not args.no_push) else 1


if __name__ == "__main__":
    raise SystemExit(main())
