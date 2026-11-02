import copy
import unittest
from journey_import import validate, merge

class ImportTests(unittest.TestCase):
    def setUp(self):
        self.report = {'researched_at':'2026-01-01T00:00:00Z','items':[{'title':'BTC research','summary':'The report discusses market risks.','symbols':['BTC'],'source_time':'Not provided by source','caveat':'Not independently verified','sources':[{'label':'Source','url':'https://example.com/news'}]}]}

    def test_valid_and_idempotent(self):
        self.assertEqual(validate(self.report), self.report)
        self.assertEqual(merge([self.report], self.report), [self.report])

    def test_no_rewrite(self):
        revised = copy.deepcopy(self.report)
        revised['items'][0]['summary'] = 'Different'
        with self.assertRaises(ValueError): merge([self.report], revised)

    def test_private_text_and_fields(self):
        for text in ['Your holdings total 2 BTC','your order is OPEN','my cost basis is 100','a@example.com','00000000-0000-0000-0000-000000000000','<script>bad</script>']:
            bad = copy.deepcopy(self.report)
            bad['items'][0]['summary'] = text
            with self.assertRaises(ValueError): validate(bad)
        self.report['account'] = 'private'
        with self.assertRaises(ValueError): validate(self.report)

    def test_sources_and_dates(self):
        for url in ['javascript:alert(1)','https://chatgpt.com/c/private','https://example.com/?token=secret','https://user:pass@example.com/']:
            bad = copy.deepcopy(self.report)
            bad['items'][0]['sources'][0]['url'] = url
            with self.assertRaises(ValueError): validate(bad)
        for date in ['2999-01-01T00:00:00Z','2026-01-01T00:00:00','invalid']:
            bad = copy.deepcopy(self.report)
            bad['researched_at'] = date
            with self.assertRaises(ValueError): validate(bad)

    def test_newest_first(self):
        newer = copy.deepcopy(self.report)
        newer['researched_at'] = '2026-01-02T00:00:00Z'
        self.assertEqual(merge([newer], self.report), [newer,self.report])

if __name__ == '__main__': unittest.main()
