"""Single-snapshot cloud entrypoint; never emit raw credential-bearing output."""
import os
import subprocess
import sys
from pathlib import Path

from daily_update import forbidden_strings


def main():
    if not all(os.environ.get(k) for k in
               ('COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY')):
        raise SystemExit('Required Coinbase Actions secrets are missing.')
    root = Path(__file__).resolve().parent.parent
    patterns = forbidden_strings()
    patterns += [os.environ['COINBASE_API_KEY_NAME'],
                 os.environ['COINBASE_API_PRIVATE_KEY']]
    def safe(text):
        for value in sorted(set(patterns), key=len, reverse=True):
            if value:
                text = text.replace(value, '[REDACTED]')
        return text

    # Verify least privilege before using the key for the report.
    import cb_client
    try:
        permissions = cb_client.get_json('/api/v3/brokerage/key_permissions')
        if (permissions.get('can_view') is not True
                or permissions.get('can_trade') is not False
                or permissions.get('can_transfer') is not False):
            raise SystemExit('Cloud refresh requires a view-only Coinbase key.')
    except Exception:
        raise SystemExit('Could not verify Coinbase key permissions.') from None

    result = subprocess.run([sys.executable, 'journal/daily_update.py', '--no-push'],
                            cwd=root, capture_output=True, text=True)
    print(safe(result.stdout), end='')
    print(safe(result.stderr), end='', file=sys.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)
    built = (root / 'journal/dist/index.html').read_bytes()
    published = (root / 'docs/index.html').read_bytes()
    if built != published:
        raise SystemExit('Generated and publication files differ.')
    if any(value and value.encode() in published for value in patterns):
        raise SystemExit('Credential scan failed; publication blocked.')
    print('View-only key verified; generated files match; credential scan passed.')


if __name__ == '__main__':
    main()
