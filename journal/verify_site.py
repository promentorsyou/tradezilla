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
from playwright.sync_api import expect

ROUTES = {'dashboard': 'Dashboard', 'live': 'Running Trades', 'days': 'Day View',
          'trades': 'Trade View', 'positions': 'Positions', 'reports': 'Reports',
          'calendar': 'Calendar', 'quant': 'Quant Pro'}


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
            expect(page.locator('#views')).not_to_be_empty()
            assert page.locator('#views').inner_text().strip()
            if route == 'quant':
                page.locator('#qp-chart canvas').first.wait_for(timeout=30000)
                assert page.locator('#qp-product option').count() >= 1
                assert page.locator('#qp-mtf tr').count() == 7
                assert page.locator('#qp-ranking tr').count() == 6
                assert 'MODELS NOT VALIDATED' in page.locator('#views').inner_text()
            assert not errors, 'Browser error detected: ' + '; '.join(errors)
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
        with urllib.request.urlopen(options.url + 'quant-data.json?build=' + expected, timeout=20) as response:
            research = response.read()
        if hashlib.sha256(research).hexdigest() != hashlib.sha256((docs / 'quant-data.json').read_bytes()).hexdigest():
            raise SystemExit('Published Quant Pro snapshot does not match the validated build.')
        print('Published Quant Pro snapshot matches SHA-256.')
        if (docs / 'quant-research.json').exists():
            with urllib.request.urlopen(options.url + 'quant-research.json?build=' + expected, timeout=20) as response:
                research_report = response.read()
            assert hashlib.sha256(research_report).hexdigest() == hashlib.sha256((docs / 'quant-research.json').read_bytes()).hexdigest(), 'Published research report differs'
            print('Published research report matches SHA-256.')
        verify(url)


if __name__ == '__main__':
    main()
