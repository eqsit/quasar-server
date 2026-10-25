import asyncio
import json
import unittest

import httpx
from services.llm_stream import Sentences, stream_completion, normalize_tool_message, spoken_text


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_sentence_is_delivered_before_generation_finishes(self):
        first_spoken = asyncio.Event()
        chunks = []
        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                data = {'choices': [{'delta': {'content': 'Первое предложение уже готово. Второе '}}]}
                yield ('data: ' + json.dumps(data) + '\n\n').encode()
                await asyncio.wait_for(first_spoken.wait(), 1)
                yield ('data: ' + json.dumps({'choices': [{'delta': {'content': 'ещё генерируется.'},
                                                         'finish_reason': 'stop'}]}) + '\n\n').encode()
                yield b'data: [DONE]\n\n'
        async def spoken(text):
            chunks.append(text)
            first_spoken.set()
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda _: httpx.Response(200, stream=Body()))) as client:
            result, prefix = await stream_completion(client, 'https://test.invalid/chat', {}, {}, spoken)
        answer = result['choices'][0]['message']['content']
        self.assertEqual(chunks, ['Первое предложение уже готово.'])
        self.assertEqual(answer[len(prefix):], 'Второе ещё генерируется.')

    async def test_fragmented_tool_arguments_are_reassembled_without_speech(self):
        deltas = [
            {'tool_calls': [{'index': 0, 'id': 'tool1', 'function': {'name': 'web_search', 'arguments': '{"q'}}]},
            {'tool_calls': [{'index': 0, 'function': {'arguments': 'uery":"новости"}'}}]},
        ]
        body = ''.join('data: ' + json.dumps({'choices': [{'delta': d}]}) + '\n\n' for d in deltas)
        body += 'data: [DONE]\n\n'
        async def no_speech(_):
            self.fail('Tool arguments must not be spoken')
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda _: httpx.Response(200, text=body))) as client:
            result, prefix = await stream_completion(client, 'https://test.invalid/chat', {}, {}, no_speech)
        call = result['choices'][0]['message']['tool_calls'][0]
        self.assertEqual(call['id'], 'tool1')
        self.assertEqual(json.loads(call['function']['arguments']), {'query': 'новости'})
        self.assertEqual(prefix, '')

    async def test_truncated_stream_is_not_reported_as_completed(self):
        async def spoken(_): pass
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda _: httpx.Response(200, text='data: {"choices":[]}\n\n'))) as client:
            with self.assertRaisesRegex(ValueError, 'before completion'):
                await stream_completion(client, 'https://test.invalid/chat', {}, {}, spoken)

    async def test_last_sentence_stays_in_the_final_response(self):
        parts = Sentences()
        self.assertEqual(parts.feed('Это единственное предложение.'), [])
        self.assertEqual(parts.pending, 'Это единственное предложение.')

    async def test_native_deepseek_tool_markup_is_executed_and_never_spoken(self):
        raw=('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_web_pages">'
             '<｜｜DSML｜｜ parameter name="urls" string="false">["https://example.com/"]'
             '</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>')
        spoken=[]
        async def say(text):spoken.append(text)
        body=''.join('data: '+json.dumps({'choices':[{'delta':{'content':piece}}]})+'\n\n'
                     for piece in [raw[:1],raw[1:15],raw[15:]])+'data: [DONE]\n\n'
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _:httpx.Response(200,text=body))) as client:
            result,_=await stream_completion(client,'https://test.invalid/chat',{}, {},say)
        self.assertEqual(spoken,[])
        message=normalize_tool_message(result['choices'][0]['message'])
        call=message['tool_calls'][0]['function']
        self.assertEqual(call['name'],'read_web_pages')
        self.assertEqual(json.loads(call['arguments']),{'urls':['https://example.com/']})
        with self.assertRaises(ValueError):spoken_text(raw)
        self.assertEqual(spoken_text('Объяснение. ```python\nprint(123)\n``` Готово.'),'Объяснение. Готово.')
