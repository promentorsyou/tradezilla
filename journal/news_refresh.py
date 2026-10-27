"""Public headlines only. No Coinbase credentials, article scraping or trading actions."""
import concurrent.futures
import datetime as dt
import email.utils
import hashlib
import html
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UTC = dt.timezone.utc
SOURCES = {
    'CoinDesk': ('https://www.coindesk.com/arc/outboundfeeds/rss/', 'coindesk.com'),
    'Cointelegraph': ('https://cointelegraph.com/rss', 'cointelegraph.com'),
    'Federal Reserve': ('https://www.federalreserve.gov/feeds/press_monetary.xml', 'federalreserve.gov'),
}
CALENDAR = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
ALIASES = {'BTC': 'bitcoin|btc', 'ETH': 'ethereum|ether|eth', 'XRP': 'xrp|ripple',
           'SOL': 'solana|sol', 'ADA': 'cardano|ada', 'ZEC': 'zcash|zec',
           'DOGE': 'dogecoin|doge', 'AVAX': 'avalanche|avax', 'LINK': 'chainlink'}

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'TradeZilla-News/1.0', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read(2_000_001)
    if len(body) > 2_000_000:
        raise ValueError('Feed exceeds size limit')
    return body

def clean(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub('<[^>]*>', '', value or ''))).strip()[:300]

def safe_url(value, domain):
    p = urllib.parse.urlsplit(value)
    return p.scheme == 'https' and not p.username and (p.hostname == domain or (p.hostname or '').endswith('.' + domain))

def parse_feed(body, source, domain, now):
    root = ET.fromstring(body)
    if root.tag != 'rss':
        raise ValueError('Unsupported or invalid RSS document')
    result = []
    for item in root.findall('./channel/item'):
        title, url = clean(item.findtext('title')), (item.findtext('link') or '').strip()
        try:
            published = email.utils.parsedate_to_datetime(item.findtext('pubDate') or '')
            if published.tzinfo is None:
                continue
            age = (now - published).total_seconds()
        except (ValueError, TypeError, OverflowError):
            continue
        if not title or not safe_url(url, domain) or not 0 <= age <= 86400:
            continue
        if re.search(r'\b(sponsored|press release|paid content)\b', title, re.I):
            continue
        symbols = [s for s, words in ALIASES.items() if re.search(r'\b(' + words + r')\b', title, re.I)]
        topic = 'Market context'
        for label, words in [('Security / operations', 'hack|exploit|outage|breach'),
                             ('Policy / macro', 'fed|fomc|inflation|rate|sec|regulation|tariff'),
                             ('Flows / liquidity', 'etf|outflow|inflow|liquidation')]:
            if re.search(r'\b(' + words + r')s?\b', title, re.I):
                topic = label
                break
        result.append({'id': hashlib.sha256(url.encode()).hexdigest()[:16], 'title': title,
                       'url': url, 'source': source, 'published_at': published.astimezone(UTC).isoformat(),
                       'symbols': symbols, 'topic': topic})
    return result

def parse_calendar(body, now):
    text = body.decode('utf-8')
    sections = re.split(r'(\d{4}) FOMC Meetings', text)
    events = []
    for i in range(1, len(sections), 2):
        year = int(sections[i])
        for month, dates in re.findall(r'fomc-meeting__month[^>]*>\s*<strong>([A-Za-z]+)</strong>.*?fomc-meeting__date[^>]*>([\d\- *]+)<', sections[i+1], re.S):
            days = re.findall(r'\d+', dates)
            month_num = dt.datetime.strptime(month, '%B').month
            end = dt.date(year, month_num, int(days[-1]))
            if now.date() <= end <= now.date() + dt.timedelta(days=60):
                events.append({'title': 'FOMC meeting', 'start_date': dt.date(year, month_num, int(days[0])).isoformat(),
                               'end_date': end.isoformat(), 'url': CALENDAR, 'source': 'Federal Reserve',
                               'note': 'Scheduled meeting dates; outcome unknown. Verify release time at source.'})
    if len(sections) < 3:
        raise ValueError('Calendar format changed')
    return sorted(events, key=lambda e: e['start_date'])

def build(now=None):
    now = now or dt.datetime.now(UTC)
    articles, statuses = [], []
    def source_job(pair):
        name, (url, domain) = pair
        try:
            rows = parse_feed(fetch(url), name, domain, now)
            return rows, {'source': name, 'ok': True, 'checked_at': now.isoformat(), 'recent_count': len(rows)}
        except Exception as exc:
            return [], {'source': name, 'ok': False, 'checked_at': now.isoformat(), 'error': type(exc).__name__}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for rows, status in pool.map(source_job, SOURCES.items()):
            articles.extend(rows)
            statuses.append(status)
    try:
        events = parse_calendar(fetch(CALENDAR), now)
        calendar_ok = True
    except Exception:
        events, calendar_ok = [], False
    seen = set()
    unique = []
    for item in sorted(articles, key=lambda a: a['published_at'], reverse=True):
        key = re.sub(r'\W+', '', item['title'].lower())
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return {'schema_version': 1, 'fetched_at': now.isoformat(), 'sources': statuses,
            'articles': unique[:60], 'events': events, 'calendar_ok': calendar_ok,
            'max_feed_age_seconds': 1800, 'max_article_age_seconds': 86400}

if __name__ == '__main__':
    data = build()
    target = Path(__file__).resolve().parents[1] / 'docs/news-data.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(data, indent=2) + '\n')
    temp.replace(target)
    print(f"News: {len(data['articles'])} recent headlines; {sum(s['ok'] for s in data['sources'])}/3 sources; calendar={data['calendar_ok']}")
