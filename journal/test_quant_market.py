import unittest
from quant_market import weeklies


class PublicMarketTest(unittest.TestCase):
    def test_weeklies_require_seven_contiguous_utc_days(self):
        rows = [{'time': 1704067200 + i*86400, 'open': 10+i, 'close': 11+i,
                 'high': 12+i, 'low': 9+i, 'volume': 2} for i in range(14)]
        result = weeklies(rows)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {'time':1704067200,'open':10,'close':17,
                                    'high':18,'low':9,'volume':14})
        self.assertEqual(len(weeklies(rows[1:])), 1)
        self.assertEqual(len(weeklies(rows[:-1])), 1)


if __name__ == '__main__':
    unittest.main()
