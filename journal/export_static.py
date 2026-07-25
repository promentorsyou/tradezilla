"""Bake the journal into one self-contained HTML file.

    python export_static.py                  -> dist/index.html      (your real data)
    python export_static.py --demo           -> dist/demo.html       (scaled, shareable)
    python export_static.py --both

The output inlines the CSS, JS and report data, so it opens straight from disk
and can be hosted on any static host (GitHub Pages, Netlify, a USB stick) with
no server, no Python and no API key.

--demo rescales every dollar amount by a constant factor so the shape of the
account - win rate, ratios, percentages, the whole story - is identical while
the actual balances are not disclosed. Use it when you want to show the journal
to someone without showing them your net worth.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DIST = os.path.join(HERE, "dist")

# Every field that carries a dollar amount, so --demo can scale them uniformly.
MONEY_FIELDS = {
    "net_pnl", "gross_pnl", "realized_pnl", "unrealized_pnl", "fees",
    "entry_cost", "exit_proceeds", "matched_cost", "open_basis", "market_value",
    "cumulative", "drawdown", "volume", "value", "net_invested", "deposits",
    "withdrawals", "clawbacks", "external_buys", "total_value", "avg_win",
    "avg_loss", "largest_win", "largest_loss", "max_drawdown", "gross_profit",
    "gross_loss", "total_fees", "trade_expectancy", "avg_daily_pnl",
    "open_market_value", "realized_from_open", "total_realized", "income",
    "expected_value", "actual_value", "residual", "tolerance", "total_return",
    "unrealized", "total", "rewards_income", "fees_paid", "volume_30d",
}
# Prices are per-unit, not balances - scaling them would make the charts lie.
PRICE_FIELDS = {"entry_price", "exit_price", "mark_price", "open_avg_price", "price"}


def scale_report(node, factor: float):
    """Recursively scale monetary values, leaving prices, counts and % alone."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in PRICE_FIELDS or k == "prices":
                out[k] = v
            elif k in MONEY_FIELDS and isinstance(v, (int, float)):
                out[k] = v * factor
            elif k in ("open_qty", "entry_qty", "exit_qty", "balance",
                       "available", "hold", "unmatched_qty"):
                out[k] = v * factor if isinstance(v, (int, float)) else v
            else:
                out[k] = scale_report(v, factor)
        return out
    if isinstance(node, list):
        return [scale_report(x, factor) for x in node]
    return node


def read(path: str) -> str:
    with open(os.path.join(STATIC, path), encoding="utf-8") as f:
        return f.read()


def build(report: dict, demo: bool, artifact: bool = False) -> str:
    html = read("index.html")
    css = read("app.css")
    charts = read("charts.js")
    app = read("app.js")

    # The bundled build has no server, so replace the fetch() bootstrap with
    # data that is already on the page.
    app = app.replace(
        "const res = await fetch('/api/report' + (refresh ? '?refresh=1' : ''));\n"
        "      if (!res.ok) {\n"
        "        const body = await res.json().catch(() => ({}));\n"
        "        throw new Error(body.error || `HTTP ${res.status}`);\n"
        "      }\n"
        "      DATA = await res.json();",
        "DATA = window.__REPORT__;",
    )
    if "window.__REPORT__" not in app:
        raise SystemExit("export: could not patch the data bootstrap in app.js")

    # Refresh cannot work without a backend.
    app = app.replace(
        "$('#refresh').addEventListener('click', () => load(true));",
        "$('#refresh').style.display = 'none';",
    )

    banner = ""
    if demo:
        banner = (
            '<div style="background:#f0a03c;color:#241a08;padding:7px 14px;'
            'font-size:12.5px;font-weight:600;text-align:center">'
            'DEMO — all dollar amounts are proportionally rescaled. '
            'Percentages, ratios and the trade history are real.</div>'
        )

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    html = html.replace(
        '<link rel="stylesheet" href="/app.css">',
        f"<style>\n{css}\n</style>",
    )
    html = html.replace(
        '<script src="/charts.js"></script>\n<script src="/app.js"></script>',
        "<script>window.__REPORT__ = "
        + json.dumps(report, default=str)
        + f";</script>\n<script>\n{charts}\n</script>\n<script>\n{app}\n</script>",
    )
    html = html.replace("<body>", "<body>" + banner)
    html = html.replace(
        "<title>Trading Journal</title>",
        f"<title>Trading Journal{' — Demo' if demo else ''}</title>",
    )
    # static snapshot: say so, rather than implying it is live
    html = html.replace(
        'Live from your Coinbase account',
        f'Snapshot exported {stamp}',
    )

    if artifact:
        # The artifact host supplies <!doctype>, <head> and <body>; emit only
        # page content. Its own theme control also replaces ours.
        body = re.search(r"<body>(.*)</body>", html, re.S)
        if not body:
            raise SystemExit("export: could not isolate body for artifact build")
        html = (f"<title>Trading Journal{' — Demo' if demo else ''}</title>\n"
                f"<style>\n{css}\n#theme-toggle{{display:none}}\n</style>\n"
                + re.sub(r"<link[^>]*>", "", body.group(1)))
    return html


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="write the rescaled build")
    ap.add_argument("--both", action="store_true", help="write both builds")
    ap.add_argument("--factor", type=float, default=None,
                    help="demo scale factor (default: normalise invested to $25,000)")
    ap.add_argument("--refresh", action="store_true", help="re-pull from Coinbase")
    ap.add_argument("--artifact", action="store_true",
                    help="also write artifact.html / artifact-demo.html for hosted publishing")
    ap.add_argument("--sample", action="store_true",
                    help="build from generated sample data - no Coinbase call, no personal data")
    args = ap.parse_args()

    os.makedirs(DIST, exist_ok=True)

    if args.sample:
        import sample_data
        print("building report from generated sample data ...")
        report = sample_data.build_sample()
        for fname, art in (("sample.html", False), ("artifact-sample.html", True)):
            p = os.path.join(DIST, fname)
            with open(p, "w", encoding="utf-8") as f:
                f.write(build(report, demo=False, artifact=art))
            print(f"  wrote {p}  ({os.path.getsize(p) / 1024:.0f} KB)")
        print("\nContains no real account data - safe to commit and publish.")
        return

    import engine
    print("building report ...")
    report = engine.build_report(force=args.refresh)

    wrote = []
    if not args.demo or args.both:
        p = os.path.join(DIST, "index.html")
        with open(p, "w", encoding="utf-8") as f:
            f.write(build(report, demo=False))
        wrote.append(p)

    if args.demo or args.both:
        invested = report["cash_flows"]["net_invested"] or 1
        factor = args.factor if args.factor else 25000.0 / invested
        p = os.path.join(DIST, "demo.html")
        with open(p, "w", encoding="utf-8") as f:
            f.write(build(scale_report(report, factor), demo=True))
        wrote.append(p)
        print(f"  demo scale factor {factor:.6f}")

    if args.artifact:
        invested = report["cash_flows"]["net_invested"] or 1
        factor = args.factor if args.factor else 25000.0 / invested
        for fname, rep, is_demo in (
            ("artifact.html", report, False),
            ("artifact-demo.html", scale_report(report, factor), True),
        ):
            p = os.path.join(DIST, fname)
            with open(p, "w", encoding="utf-8") as f:
                f.write(build(rep, demo=is_demo, artifact=True))
            wrote.append(p)

    for p in wrote:
        print(f"  wrote {p}  ({os.path.getsize(p) / 1024:.0f} KB)")
    print("\nOpen the file directly in a browser, or host the dist/ folder anywhere.")


if __name__ == "__main__":
    main()
