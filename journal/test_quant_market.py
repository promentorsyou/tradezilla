import unittest
from quant_market import weeklies, coverage, public_book
from quant_journal import extend_journal
from unittest.mock import patch


class PublicMarketTest(unittest.TestCase):
    def test_exact_pair_rejection(self):
        with patch('quant_market.get',return_value={'pricebook':{'product_id':'XRP-USD'}}):
            with self.assertRaises(ValueError):public_book('XRP-USDC')

    def test_coverage_without_gap_filling(self):
        self.assertEqual(coverage([{'time':0},{'time':60},{'time':180}],60)['contiguous'],1)

    def test_immutable_observation_journal(self):
        c={'state':'ARMED','setup':'Test','timestamp':0,'rule_version':'test','entry':100,'stop':99,'targets':[101],'next_action':'Wait'}
        p={'product_id':'XRP-USDC','candidates':[c]}
        first=extend_journal({},[p],0);original=dict(first['observations'][0])
        again=extend_journal(first,[p],1)
        self.assertEqual(len(again['observations']),1)
        self.assertEqual(again['observations'][0],original)
        final=extend_journal(again,[p],4000)
        self.assertEqual(final['observations'][0],original)
        self.assertEqual(final['outcomes'][0]['status'],'UNRESOLVED_MISSING_DATA')

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
