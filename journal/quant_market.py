"""Publish public spot-market history for the static Quant Pro page.

No account client, authentication, or private environment variables are used.
Coinbase REST disallows browser CORS; GitHub generates this public snapshot.
"""
import concurrent.futures
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = 'https://api.coinbase.com/api/v3/brokerage'
PRODUCTS = ['XRP-USDC', 'BTC-USDC', 'ETH-USDC', 'SOL-USDC', 'ADA-USDC', 'ZEC-USDC']


def get(path, params=None):
    url = BASE + path + ('?' + urllib.parse.urlencode(params) if params else '')
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'TradeZilla-PublicResearch/1.0'})
            with urllib.request.urlopen(req, timeout=25) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code != 429 and exc.code < 500:
                raise
            if attempt == 2:
                raise
        except (OSError, ValueError):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)


def candles(product, granularity, seconds, count, now):
    end = now // seconds * seconds  # current open candle is excluded
    start = end - count * seconds
    found = {}
    for cursor in range(start, end, 350 * seconds):
        data = get('/market/products/' + product + '/candles', {
            'start': cursor, 'end': min(cursor + 349 * seconds, end - 1),
            'granularity': granularity, 'limit': 350})
        for raw in data.get('candles', []):
            row = {k: float(raw[k]) for k in ('open', 'high', 'low', 'close', 'volume')}
            row['time'] = int(raw['start'])
            if not all(math.isfinite(v) for v in row.values()):
                raise ValueError('Nonfinite public candle')
            if (row['low'] <= 0 or row['high'] < max(row['open'], row['close'])
                    or row['low'] > min(row['open'], row['close']) or row['volume'] < 0
                    or row['time'] % seconds):
                raise ValueError('Invalid public candle')
            if start <= row['time'] < end:
                found[row['time']] = row
    return sorted(found.values(), key=lambda r: r['time'])


def weeklies(daily):
    groups = {}
    for c in daily:
        day = datetime.fromtimestamp(c['time'], timezone.utc)
        start = c['time'] - day.weekday() * 86400
        groups.setdefault(start, []).append(c)
    out = []
    for start, rows in sorted(groups.items()):
        if [r['time'] for r in rows] != list(range(start, start + 604800, 86400)):
            continue
        out.append({'time': start, 'open': rows[0]['open'], 'high': max(r['high'] for r in rows),
                    'low': min(r['low'] for r in rows), 'close': rows[-1]['close'],
                    'volume': sum(r['volume'] for r in rows)})
    return out


def build_product(product, now):
    p = get('/market/products/' + product)
    if p.get('product_type') != 'SPOT' or p.get('status') != 'online' or p.get('is_disabled'):
        return {'product_id': product, 'available': False, 'reason': 'Not an active spot product'}
    daily = candles(product, 'ONE_DAY', 86400, 1500, now)
    frames = {'1H': candles(product, 'ONE_HOUR', 3600, 300, now),
              '4H': candles(product, 'FOUR_HOUR', 14400, 300, now),
              '1D': daily[-300:], '1W': weeklies(daily)[-220:]}
    return {'product_id': product, 'available': True, 'alias': p.get('alias') or product,
            'name': p['base_name'], 'price': p['price'], 'change': p['price_percentage_change_24h'],
            'volume': p['volume_24h'], 'increment': p['quote_increment'], 'frames': frames,
            'fetched_at': datetime.now(timezone.utc).isoformat()}


def main():
    now = int(get('/time')['epochSeconds'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        products = list(pool.map(lambda p: build_product(p, now), PRODUCTS))
    result = {'version': 1, 'source': 'Coinbase Advanced Trade public REST',
              'generated_at': datetime.now(timezone.utc).isoformat(), 'exchange_time': now,
              'note': 'Completed candles only. GitHub-scheduled snapshot; ticker is streamed separately.',
              'products': products}
    destination = Path(__file__).resolve().parent.parent / 'docs/quant-data.json'
    temporary = destination.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    temporary.replace(destination)
    print('Public Quant Pro snapshot saved: ' + ', '.join(p['product_id'] for p in products))


if __name__ == '__main__':
    main()
