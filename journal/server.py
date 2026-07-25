"""Trading journal web server.

    python server.py [--port 8000] [--host 127.0.0.1]

Serves the dashboard at / and JSON at /api/report. Standard library only —
no framework to install, nothing to break on a fresh machine.

The report is computed once and cached in memory; /api/report?refresh=1
forces a rebuild from Coinbase.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import engine

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

_lock = threading.Lock()
_cache: dict = {"report": None, "built_at": None, "error": None}


def get_report(refresh: bool = False) -> dict:
    with _lock:
        if _cache["report"] is not None and not refresh:
            return _cache["report"]
        try:
            report = engine.build_report(force=refresh)
            _cache.update(report=report, built_at=datetime.now(timezone.utc),
                          error=None)
            return report
        except Exception as exc:
            _cache["error"] = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
            raise


class Handler(BaseHTTPRequestHandler):
    server_version = "TradeJournal/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"  {self.address_string()} {fmt % args}\n")

    # -- helpers ----------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str, cache: str = "no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, payload: dict):
        self._send(code, json.dumps(payload, default=str).encode(),
                   "application/json; charset=utf-8")

    # -- routes -----------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        query = parse_qs(url.query)

        try:
            if path == "/api/report":
                refresh = query.get("refresh", ["0"])[0] in ("1", "true", "yes")
                self._json(200, get_report(refresh))
                return

            if path == "/api/health":
                self._json(200, {
                    "ok": True,
                    "built_at": _cache["built_at"].isoformat()
                    if _cache["built_at"] else None,
                    "last_error": _cache["error"],
                })
                return

            if path.startswith("/api/"):
                self._json(404, {"error": "unknown endpoint"})
                return

            # static files
            rel = "index.html" if path in ("/", "") else path.lstrip("/")
            target = os.path.normpath(os.path.join(STATIC, rel))
            if not target.startswith(STATIC) or not os.path.isfile(target):
                # single-page app: unknown paths render the shell
                target = os.path.join(STATIC, "index.html")
            ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype == "application/javascript":
                ctype += "; charset=utf-8"
            with open(target, "rb") as f:
                self._send(200, f.read(), ctype)

        except BrokenPipeError:
            pass
        except Exception as exc:
            traceback.print_exc()
            self._json(500, {"error": str(exc), "type": type(exc).__name__})

    do_HEAD = do_GET


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--warm", action="store_true",
                    help="build the report before accepting requests")
    args = ap.parse_args()

    if args.warm:
        print("building report from Coinbase ...")
        r = get_report(refresh=True)
        s = r["summary"]
        print(f"  {s['trade_count']} closed trades, {s['open_count']} open, "
              f"portfolio ${r['portfolio']['total_value']:,.2f}")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"\n  Trading journal running -> http://{args.host}:{args.port}\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        srv.shutdown()


if __name__ == "__main__":
    main()
