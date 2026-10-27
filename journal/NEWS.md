# Public news decision context

Dashboard and Running Trades share a public-only news snapshot. No account identifiers or holdings are transmitted to publishers; relevance filtering happens in the browser. Headline keyword tags are not sentiment, verified impact, or investment recommendations.

`news_refresh.py` fetches CoinDesk, Cointelegraph and the Federal Reserve monetary-policy RSS feeds concurrently, with timeouts and response-size limits. It stores headlines and publisher links only, strips markup, allowlists HTTPS publisher domains, rejects missing/future timestamps, excludes articles older than 24 hours, and deduplicates normalized headlines. No article bodies are stored. Source errors replace—not refresh—the failed source's content. Successful retrieval does not establish that a publisher's coverage is complete or up to date.

Upcoming FOMC meeting dates come from the official Federal Reserve calendar, not inferred news dates. Dates expire after the meeting ends. BLS inflation/jobs data is a direct official-calendar link, not an imported schedule. Event outcomes and unscheduled events are unknown.

The independent `news.yml` workflow is scheduled every five minutes, without Coinbase credentials. It shares the Pages deployment concurrency group. GitHub may delay or replace queued jobs: this is not a real-time news service. A browser checks the published JSON every minute while the panel is mounted and on return to the tab. It reevaluates expiry every 15 seconds. A snapshot over 30 minutes old, a failed fetch, or invalid response hides the current-headline list. Articles also expire individually at 24 hours. A visible warning is the safety mechanism when collection/publication fails; uninterrupted freshness cannot be guaranteed.

Run `python3 -m unittest discover -s journal -p test_news.py`, `python3 journal/news_refresh.py`, `python3 journal/rebuild_ui.py`, and `node --test journal/test_news_ui.cjs`. Existing portfolio accounting and Quant Pro calculations are unchanged.
