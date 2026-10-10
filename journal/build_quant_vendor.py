"""Vendor the installed chart library mechanically; not run by scheduled refreshes."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
package = root / 'coinbase-quant-pro/apps/web/node_modules/lightweight-charts'
target = root / 'journal/static/vendor'
target.mkdir(exist_ok=True)
for source, name in [('dist/lightweight-charts.standalone.production.js', 'lightweight-charts-5.2.1.js'),
                     ('LICENSE', 'LIGHTWEIGHT-CHARTS-LICENSE')]:
    (target / name).write_bytes((package / source).read_bytes())
print('Vendored Lightweight Charts 5.2.1 and license.')
