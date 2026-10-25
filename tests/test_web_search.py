import asyncio
import unittest
from unittest.mock import patch
import httpx
from services import web_search

class WebTests(unittest.TestCase):
    def test_public_url_validation(self):
        for value in ['http://127.0.0.1/a','http://10.1.2.3/','http://localhost/','file:///etc/passwd','https://user:pass@example.com/']:
            self.assertFalse(web_search.public_url(value))
        self.assertTrue(web_search.public_url('https://example.com/path'))

    def test_search_decodes_entities_and_uses_only_serper_key(self):
        def handle(request):
            self.assertEqual(request.url.host,'google.serper.dev')
            self.assertEqual(request.headers['x-api-key'],'test-key')
            self.assertNotIn('authorization',request.headers)
            return httpx.Response(200,json={'organic':[{'title':'A &amp; B','link':'https://example.com','snippet':'Text'}]})
        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                result=await web_search.search(client,'test')
                self.assertEqual(result['results'][0]['title'],'A & B')
        with patch.object(web_search,'KEY','test-key'):
            asyncio.run(main())

    def test_extract_deduplicates_and_bounds_page_text(self):
        calls=[]
        def handle(request):
            calls.append(request)
            return httpx.Response(200,json={'metadata':{'title':'Title'},'text':'x'*10000})
        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                result=await web_search.extract(client,['https://example.com','https://example.com','file:///etc/passwd'],1000)
                self.assertEqual(len(result['pages']),1)
                self.assertEqual(len(result['pages'][0]['text']),1000)
        with patch.object(web_search,'KEY','test-key'):
            asyncio.run(main())
        self.assertEqual(len(calls),1)

if __name__=='__main__':unittest.main()
