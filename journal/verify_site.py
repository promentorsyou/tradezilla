"""Verify the rendered routes locally or compare a deployed site to docs/."""
import argparse
import functools
import hashlib
import http.server
import threading
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROUTES = {'dashboard': 'Dashboard', 'live': 'Running Trades', 'days': 'Day View',
          'trades': 'Trade View', 'positions': 'Positions', 'reports': 'Reports',
          'calendar': 'Calendar'}


def verify(url):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        for route, title in ROUTES.items():
            page.goto(url + '#/' + route)
            page.get_by_role('heading', name=title, exact=True).wait_for()
            assert 'Reconciled' in page.locator('#recon-badge').inner_text()
            assert 'Render error:' not in page.locator('#views').inner_text()
            assert page.locator('#views').inner_text().strip()
            assert not errors, 'Browser error detected'
            print(f'PASS: {route}')
        browser.close()


def main():
    args = argparse.ArgumentParser()
    mode = args.add_mutually_exclusive_group(required=True)
    mode.add_argument('--local', action='store_true')
    mode.add_argument('--url')
    options = args.parse_args()
    docs = Path(__file__).resolve().parent.parent / 'docs'
    if options.local:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(docs))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            verify(f'http://127.0.0.1:{server.server_port}/')
        finally:
            server.shutdown()
    else:
        expected = hashlib.sha256((docs / 'index.html').read_bytes()).hexdigest()
        for attempt in range(30):
            url = options.url + '?build=' + expected + '&attempt=' + str(attempt)
            try:
                with urllib.request.urlopen(url, timeout=20) as response:
                    actual = hashlib.sha256(response.read()).hexdigest()
                if actual == expected:
                    break
            except OSError:
                pass
            time.sleep(10)
        else:
            raise SystemExit('Published HTML does not match the validated build.')
        print('Published HTML matches SHA-256 ' + expected)
        verify(url)


if __name__ == '__main__':
    main()
