"""Search and extraction ported from the user's OpenCode/Hermes web-serper integration."""
import asyncio
import html
import ipaddress
import os
from urllib.parse import urlsplit

import httpx

KEY = os.getenv('SERPER_API_KEY', '')


def public_url(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            return False
        host = parsed.hostname.lower()
        if host == 'localhost' or host.endswith(('.local', '.localhost', '.internal')):
            return False
        try:
            return ipaddress.ip_address(host).is_global
        except ValueError:
            return True
    except ValueError:
        return False


async def post(client, endpoint, payload, timeout=3, attempts=2):
    if not KEY:
        raise ValueError('Serper is not configured')
    for attempt in range(attempts):
        try:
            response = await client.post(endpoint, json=payload, headers={'X-API-KEY': KEY}, timeout=timeout)
            if (response.status_code == 429 or response.status_code >= 500) and attempt < attempts-1:
                await asyncio.sleep(0.4)
                continue
            response.raise_for_status()
            return response.json()
        except (httpx.TimeoutException, httpx.ConnectError):
            if attempt == attempts-1:
                raise
            await asyncio.sleep(0.4)


async def search(client, query, news=False, limit=5):
    query = str(query).strip()[:500]
    if not query:
        raise ValueError('Empty search query')
    limit = max(1, min(8, int(limit)))
    data = await post(client, 'https://google.serper.dev/news' if news else 'https://google.serper.dev/search',
                      {'q': query, 'num': limit, 'hl': 'ru', 'gl': 'ru'})
    rows = data.get('news' if news else 'organic', [])
    result = {'source': 'Serper/Google', 'results': [
        {'title': html.unescape(str(row.get('title', ''))), 'url': row.get('link', ''),
         'text': html.unescape(str(row.get('snippet', row.get('description', ''))))[:1800],
         'date': row.get('date')} for row in rows[:limit]]}
    if data.get('answerBox'):
        result['answer_box'] = data['answerBox']
    return result


async def extract(client, urls, max_chars=6000):
    selected = list(dict.fromkeys(str(url).strip() for url in urls if public_url(str(url).strip())))[:3]
    if not selected:
        raise ValueError('No public HTTP URLs')
    budget = max(500, min(12000, int(max_chars)))
    semaphore = asyncio.Semaphore(3)
    async def one(url):
        try:
            async with semaphore:
                data = await post(client, 'https://scrape.serper.dev', {'url': url}, timeout=3, attempts=1)
            metadata = data.get('metadata') or {}
            return {'url': url, 'title': html.unescape(str(metadata.get('title', metadata.get('ogTitle', '')))),
                    'text': str(data.get('text', ''))[:budget]}
        except (httpx.HTTPError, ValueError):
            return {'url': url, 'error': 'Не удалось прочитать страницу'}
    return {'source': 'Serper Scrape', 'pages': await asyncio.gather(*(one(url) for url in selected))}
