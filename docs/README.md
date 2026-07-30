# GitHub Pages

`index.html` is the live trading journal published at
<https://promentorsyou.github.io/tradezilla/> — all trades, all six views,
with **real, unscaled dollar amounts**, at the owner's explicit request.

This page is **public to anyone with the link** and is indexable by search
engines. It discloses portfolio value, holdings, cost basis, realized and
unrealized P&L, and open orders.

It contains **no credentials**. The API key and private key live only in
environment variables on the owner's machine and are never written to any
build. Nothing here grants access to the Coinbase account — it is a read-only
snapshot of numbers.

Refresh after new trades:

```bash
cd journal && ./venv/bin/python export_static.py --refresh
cp dist/index.html ../docs/index.html
git commit -am "refresh journal" && git push
```

To go back to hiding balances, publish the rescaled build instead — every
ratio and date stays true, only dollar magnitudes change:

```bash
./venv/bin/python export_static.py --demo && cp dist/demo.html ../docs/index.html
```
