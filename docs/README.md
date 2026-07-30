# GitHub Pages

`index.html` is the **full trading journal** — every trade, every day, and all
six dashboard views (Dashboard, Day View, Trade View, Positions, Reports,
Calendar).

Every ratio and percentage in it is **real**: win rate, profit factor,
win/loss ratio, Zella score, trade dates, symbols and hold times. Only the
**dollar magnitudes are rescaled by a single constant**, so the account's
performance is faithfully represented without disclosing actual balances.

Rebuild after new trades:

```bash
cd journal && ./venv/bin/python export_static.py --demo
cp dist/demo.html ../docs/index.html && cp dist/demo.html ../docs/demo.html
```

Never copy `dist/index.html` or `dist/artifact.html` here — those carry real
balances, and GitHub Pages on a public repo is visible to everyone.

## Enabling the site (one-time, owner only)

GitHub blocks apps from turning Pages on, so this must be done by hand:

**Settings → Pages → Build and deployment → Source: "Deploy from a branch"
→ Branch `main`, folder `/docs` → Save.**

The site appears at `https://promentorsyou.github.io/tradezilla/` within a
minute or two.
