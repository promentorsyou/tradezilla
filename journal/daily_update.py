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
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES_REPO = os.environ.get("TRADEZILLA_REPO", "/workspace/tradezilla")

# Strings that must never reach a public build.
FORBIDDEN = ("94cc1312", "af725aaf", "MHcCAQEE", "oAoGCCqGSM49",
             "BEGIN EC PRIVATE KEY-----\\nMH", "COINBASE_API_PRIVATE_KEY=")


def log(msg: str = "") -> None:
    print(msg, flush=True)


def run(cmd: list[str], cwd: str) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


# --------------------------------------------------------------------------
# 1-3. pull and rebuild
# --------------------------------------------------------------------------
def refresh() -> dict:
    import engine
    log("→ pulling fills and ledger from Coinbase ...")
    report = engine.build_report(force=True)
    s, rec = report["summary"], report["reconciliation"]
    log(f"  {s['trade_count']} closed trades, {s['open_count']} open, "
        f"{report['event_count']} events")
    log(f"  gross fees ${s['gross_fees']:,.2f} − rebate ${s['fee_rebates']:,.2f} "
        f"= net ${s['total_fees']:,.2f}")
    log(f"  portfolio ${rec['actual_value']:,.2f} | "
        f"return ${rec['total_return']:+,.2f} ({rec['total_return_pct']:+.2f}%)")
    return report


# --------------------------------------------------------------------------
# 4. integrity checks - publishing is blocked unless these pass
# --------------------------------------------------------------------------
def verify(report: dict) -> list[str]:
    import engine
    s, rec = report["summary"], report["reconciliation"]
    fails: list[str] = []

    if not rec["balanced"]:
        fails.append(f"reconciliation off by ${rec['residual']:,.2f} "
                     f"(tolerance ${rec['tolerance']:,.2f})")

    # FIFO positions must equal what Coinbase says you hold
    actual = {}
    for a in engine.fetch_accounts():
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
def publish(scaled: bool, push: bool) -> bool:
    import export_static

    log("→ building static site ...")
    argv = sys.argv
    sys.argv = ["export_static.py", "--demo" if scaled else ""]
    sys.argv = [a for a in sys.argv if a]
    try:
        export_static.main()
    finally:
        sys.argv = argv

    built = os.path.join(HERE, "dist", "demo.html" if scaled else "index.html")
    if not os.path.exists(built):
        log(f"  ! expected build missing: {built}")
        return False

    with open(built, encoding="utf-8") as f:
        html = f.read()
    leaked = [p for p in FORBIDDEN if p in html]
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
        report = refresh()
    except Exception as exc:
        log(f"! could not reach Coinbase: {type(exc).__name__}: {exc}")
        log("  check COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY")
        return 2

    log("→ verifying ...")
    fails = verify(report)
    if fails:
        log("  FAILED:")
        for f in fails:
            log(f"    - {f}")
        log("  refusing to publish numbers that do not check out")
        return 1
    rec = report["reconciliation"]
    log(f"  all checks pass (residual ${rec['residual']:,.2f}, "
        f"{abs(rec['residual'])/max(rec['actual_value'],1)*100:.3f}%)")

    if args.check_only:
        log("→ check-only, nothing published")
        return 0

    return 0 if publish(args.scaled, not args.no_push) else 1


if __name__ == "__main__":
    raise SystemExit(main())
