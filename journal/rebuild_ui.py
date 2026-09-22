"""Rebuild presentation from the published snapshot, without Coinbase access.

Run from any directory: python3.13 journal/rebuild_ui.py
The existing report and its timestamp are preserved exactly.
"""
import json
import re
from pathlib import Path

from export_static import build


def report_from_html(html):
    match = re.search(r"window\.__REPORT__ = (.*?);</script>", html, re.S)
    if not match:
        raise SystemExit("Missing embedded portfolio snapshot; UI build stopped.")
    return json.loads(match.group(1))


def main():
    root = Path(__file__).resolve().parent.parent
    published = root / "docs/index.html"
    report = report_from_html(published.read_text())
    output = build(report, demo=False)
    if report_from_html(output) != report:
        raise SystemExit("Portfolio data changed; UI build stopped.")
    dist = root / "journal/dist/index.html"
    dist.parent.mkdir(exist_ok=True)
    dist.write_text(output)
    published.write_text(output)
    print(f"UI rebuilt; snapshot {report['generated_at']} preserved exactly.")
    print("docs/index.html and journal/dist/index.html are identical.")


if __name__ == "__main__":
    main()
