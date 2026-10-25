"""OpenAI SSE assembly with complete sentences for the existing Quasar callbacks."""
import json
import re
import html
from uuid import uuid4


DSML = r'(?:｜｜|\|\|)DSML(?:｜｜|\|\|)\s*'


def normalize_tool_message(message):
    text = message.get('content') or ''
    if 'DSML' not in text:
        return message
    calls = []
    for invoke in re.finditer(r'<' + DSML + r'invoke\s+name="([^"]+)">([\s\S]*?)</' + DSML + r'invoke>', text):
        arguments = {}
        for parameter in re.finditer(r'<' + DSML + r'parameter\s+name="([^"]+)"\s+string="(true|false)">([\s\S]*?)</' + DSML + r'parameter>', invoke[2]):
            value = html.unescape(parameter[3])
            arguments[parameter[1]] = value if parameter[2] == 'true' else json.loads(value)
        calls.append({'id':'dsml_'+uuid4().hex, 'type':'function', 'function':{
            'name':invoke[1], 'arguments':json.dumps(arguments,ensure_ascii=False)}})
    if not calls:
        raise ValueError('Malformed provider tool serialization')
    return {'role':'assistant','content':None,'tool_calls':calls}


def spoken_text(text):
    if 'DSML' in text:
        raise ValueError('Provider tool serialization is not speech')
    text = re.sub(r'<think>[\s\S]*?(?:</think>|$)', '', text, flags=re.I)
    text = re.sub(r'```[\s\S]*?(?:```|$)', '', text)
    text = re.sub(r'`[^`]*`', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    text = re.sub(r'<[^>]*>', '', text)
    text = re.sub(r'(?m)^\s*(?:#{1,6}|[-*])\s+', '', text)
    return re.sub(r'\s+', ' ', text.replace('**','')).strip()


class Sentences:
    def __init__(self):
        self.pending = ''
        self.emitted = ''

    def feed(self, text):
        self.pending += text
        chunks = []
        # Keep the last sentence for the final response, including its follow-up flag.
        while match := re.search(r'(?<=[.!?])\s+(?=\S)', self.pending):
            end = match.end()
            if len(self.pending[:end].strip()) < 20:
                break
            chunk, self.pending = self.pending[:end], self.pending[end:]
            self.emitted += chunk
            chunks.append(chunk.strip())
        return chunks


async def stream_completion(client, url, payload, headers, on_sentence):
    message = {'role': 'assistant', 'content': ''}
    calls = {}
    sentences = Sentences()
    saw_finish = False
    async with client.stream('POST', url, json={**payload, 'stream': True}, headers=headers) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if not line.startswith('data:'):
                continue
            raw = line[5:].strip()
            if raw == '[DONE]':
                saw_finish = True
                break
            data = json.loads(raw)
            if data.get('error'):
                raise ValueError('LLM stream returned an error')
            for choice in data.get('choices', []):
                if choice.get('index', 0) != 0:
                    continue
                delta = choice.get('delta') or {}
                for call in delta.get('tool_calls') or []:
                    index = call.get('index', 0)
                    item = calls.setdefault(index, {'id': '', 'type': 'function',
                                                   'function': {'name': '', 'arguments': ''}})
                    if call.get('id'):
                        item['id'] = call['id']
                    for name in ('name', 'arguments'):
                        item['function'][name] += call.get('function', {}).get(name) or ''
                content = delta.get('content') or ''
                if content:
                    message['content'] += content
                    # Hold markup as soon as its opening character arrives, even
                    # across SSE chunks. DSML is parsed into real tool calls later.
                    if not calls and not any(x in message['content'] for x in ('<','`','｜')):
                        for sentence in sentences.feed(content):
                            await on_sentence(sentence)
                if choice.get('finish_reason'):
                    saw_finish = True
    if not saw_finish:
        raise ValueError('LLM stream ended before completion')
    if calls:
        message['tool_calls'] = [calls[index] for index in sorted(calls)]
    return {'choices': [{'message': message}]}, sentences.emitted
