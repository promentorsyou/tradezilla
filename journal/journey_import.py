"""Validate and append an editorially sanitized report. Never reads private chats or APIs.

Usage: python3 journal/journey_import.py /path/to/public-report.json
       python3 journal/journey_import.py --check
The agent must review public text BEFORE calling this; regex checks are defense-in-depth,
not a privacy classifier. Never pass a raw chat transcript to this program.
"""
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

DEST = Path(__file__).resolve().parents[1] / 'docs/journey-news.json'
PRIVATE = re.compile(r'\b(?:your|my)\s+(?:order|holding|portfolio|balance|entry|cost|purchase|account)|cost basis|reserved BTC|private.key|api.key|[\w.+-]+@[\w.-]+\.[a-z]{2,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', re.I)

def timestamp(s):
    value = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('Timezone required')
    return value

def validate(report, now=None):
    now = now or datetime.now(timezone.utc)
    if set(report) != {'researched_at', 'items'}:
        raise ValueError('Only public report fields permitted')
    if timestamp(report['researched_at']) > now:
        raise ValueError('Future research timestamp')
    if not isinstance(report['items'], list) or not 1 <= len(report['items']) <= 30:
        raise ValueError('Expected 1–30 public news items')
    for item in report['items']:
        if set(item) != {'title','summary','symbols','source_time','caveat','sources'}:
            raise ValueError('Unexpected item fields')
        for key in ('title','summary','source_time','caveat'):
            value = item[key]
            if not isinstance(value, str) or not 1 <= len(value) <= 1500 or PRIVATE.search(value) or '<' in value or '>' in value:
                raise ValueError('Unsafe or invalid public text')
        if not isinstance(item['symbols'], list) or not item['symbols'] or any(not re.fullmatch('[A-Z0-9]{2,12}', s) for s in item['symbols']):
            raise ValueError('Invalid symbols')
        if not isinstance(item['sources'], list) or not 1 <= len(item['sources']) <= 8:
            raise ValueError('Source links required')
        for source in item['sources']:
            if set(source) != {'label','url'}:
                raise ValueError('Unexpected source fields')
            url = urlsplit(source['url'])
            if url.scheme != 'https' or not url.hostname or '.' not in url.hostname or url.username or url.password or url.query or url.fragment or url.hostname in ('chatgpt.com', 'localhost'):
                raise ValueError('Public HTTPS source URL required, without tracking or private links')
            if PRIVATE.search(source['url']) or not isinstance(source['label'], str) or not 1 <= len(source['label']) <= 100 or PRIVATE.search(source['label']):
                raise ValueError('Unsafe source')
    return report

def merge(existing, report):
    validate(report)
    for old in existing:
        validate(old)
        if timestamp(old['researched_at']) == timestamp(report['researched_at']):
            if old != report:
                raise ValueError('Report already imported; do not silently rewrite history')
            return existing
    return sorted([*existing, report], key=lambda r: timestamp(r['researched_at']), reverse=True)[:168]

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input', nargs='?')
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()
    data = json.loads(DEST.read_text()) if DEST.exists() else {'schema_version':1,'reports':[]}
    if set(data) != {'schema_version','reports'} or data['schema_version'] != 1 or not isinstance(data['reports'], list) or len(data['reports']) > 168:
        raise ValueError('Invalid research archive')
    for report in data['reports']:
        validate(report)
    if args.check:
        print(f"Validated {len(data['reports'])} public reports")
        return
    if not args.input:
        ap.error('Input report required')
    reports = merge(data['reports'], json.loads(Path(args.input).read_text()))
    if reports == data['reports']:
        print('No new report; timestamp unchanged')
        return
    data['reports'] = reports
    temp = DEST.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temp.replace(DEST)
    print(f"Imported public research; newest report {reports[0]['researched_at']}")

if __name__ == '__main__':
    main()
