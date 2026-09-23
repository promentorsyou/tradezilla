# GitHub Pages

## UI development

Edit `journal/static/index.html`, `app.css`, `app.js`, and `charts.js`.
From the repository root, run `python3.13 journal/rebuild_ui.py` to rebuild
the published page using its existing portfolio snapshot. This makes no
Coinbase requests and verifies that the complete report remains unchanged.
The normal daily refresh uses the same templates, so UI changes persist.

The interface supports light/dark themes, a saved compact layout, and
Cmd/Ctrl+K page navigation. Verify all seven routes at desktop and phone
widths before publishing; run the configured credential hook before commit.

## Publication

Hourly cloud refreshes run in `.github/workflows/refresh.yml` at minute 17
of every hour (UTC), independent of the laptop. GitHub may delay scheduled
runs. The `COINBASE_API_KEY_NAME` and `COINBASE_API_PRIVATE_KEY` Actions
secrets must hold a view-only key; every run verifies that permission.
The job uses one snapshot, runs all accounting checks, scans credentials,
tests seven routes, commits only `docs/index.html`, deploys Pages directly,
then verifies the published hash and routes. Failures stop publication.
Pages must use the GitHub Actions build source. A manual workflow dispatch
can test or recover a run. No trading or transfer access is required.

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
