import datetime as dt
import unittest
from unittest.mock import patch
import news_refresh as n

class NewsTests(unittest.TestCase):
    def test_dates_links_and_duplicates_input(self):
        now = dt.datetime(2026, 10, 26, 12, tzinfo=n.UTC)
        def item(date, url='https://coindesk.com/markets/test'):
            return f'<item><title>Bitcoin ETF flows</title><link>{url}</link><pubDate>{date}</pubDate></item>'
        body = ('<rss><channel>' + item('Mon, 26 Oct 2026 11:00:00 GMT') + item('Sun, 25 Oct 2026 10:00:00 GMT') + item('Tue, 27 Oct 2026 12:00:00 GMT') + item('bad') + item('Mon, 26 Oct 2026 11:00:00 GMT','https://evil.example/') + '</channel></rss>').encode()
        rows = n.parse_feed(body, 'CoinDesk', 'coindesk.com', now)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['symbols'],['BTC'])
        self.assertEqual(rows[0]['topic'],'Flows / liquidity')

    def test_fail_closed(self):
        with patch.object(n, 'fetch', side_effect=OSError):
            data = n.build()
        self.assertEqual(data['articles'],[])
        self.assertFalse(any(s['ok'] for s in data['sources']))
        self.assertFalse(data['calendar_ok'])

    def test_calendar_rollover(self):
        body = b'2026 FOMC Meetings <div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9*</div>2027 FOMC Meetings <div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">26-27</div>'
        rows = n.parse_calendar(body, dt.datetime(2026,12,10,tzinfo=n.UTC))
        self.assertEqual([e['end_date'] for e in rows], ['2027-01-27'])

if __name__ == '__main__': unittest.main()
