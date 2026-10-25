"""Small TTS adapters; all account keys stay server-side."""
import asyncio
import base64
import io
import json
import os
import re
import time
import wave

import edge_tts

EDGE_VOICES = {'ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural', 'en-US-AriaNeural', 'en-US-GuyNeural'}
GEMINI_VOICES = {'Sulafat', 'Kore', 'Aoede', 'Leda', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Laomedeia'}
INWORLD_VOICES = {'Alyona', 'Elena', 'Oksana', 'Tamara', 'Snezhana', 'Yulia', 'Polina', 'Svetlana',
                  'Galina', 'Dmitry', 'Nikolai', 'Timofey', 'Grigory', 'Yegor', 'Rodion', 'Stepan',
                  'Vadim', 'Lev', 'Ruslan', 'Arkady', 'Gleb', 'Ashley'}
gemini_blocked_until = 0.0
inworld_blocked_until = 0.0


def effective_provider(provider):
    if provider == 'gemini' and time.monotonic() < gemini_blocked_until:
        return effective_provider('inworld') if os.getenv('INWORLD_API_KEY') else 'edge'
    if provider == 'inworld' and time.monotonic() < inworld_blocked_until:
        return 'edge'
    return provider


def validate_voice(provider, voice):
    if provider == 'edge':
        return voice in EDGE_VOICES
    if provider == 'gemini':
        return voice in GEMINI_VOICES
    if provider == 'inworld':
        return voice in INWORLD_VOICES
    return False


async def synthesize(client, provider, text, voice, speed):
    """Return encoded audio, whether the provider applied the speed, and its container.

    The container matters: Ogg/Opus from the provider can go to the Station as is,
    while WAV/MP3 still needs a local ffmpeg pass.
    """
    if provider == 'edge':
        audio = bytearray()
        communicate = edge_tts.Communicate(text, voice,
            rate=f'{round((speed-1)*100):+d}%', proxy=os.getenv('EDGE_TTS_PROXY') or None)
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                audio.extend(chunk['data'])
        if not audio:
            raise ValueError('Edge returned no audio')
        return bytes(audio), True, 'mp3'
    if provider == 'inworld':
        if effective_provider(provider) != provider:
            raise ValueError('Inworld quota cooldown is active')
        key = os.getenv('INWORLD_API_KEY', '')
        if not key:
            raise ValueError('Inworld speech key is missing')
        rate = speed if 0.5 <= speed <= 1.5 else 1
        response = await client.post('https://api.inworld.ai/tts/v1/voice',
            headers={'Authorization':'Basic '+key}, json={
                'text':text, 'voiceId':voice, 'modelId':os.getenv('INWORLD_TTS_MODEL','inworld-tts-2-flash'),
                'language':'ru-RU', 'audioConfig':{'audioEncoding':'OGG_OPUS','sampleRateHertz':24000,
                    'speakingRate':rate,'bitRate':48000}},
            timeout=8)
        if response.status_code in (402, 429):
            global inworld_blocked_until
            inworld_blocked_until = time.monotonic() + (3600 if response.status_code == 402 else 60)
        response.raise_for_status()
        audio = base64.b64decode(response.json().get('audioContent',''), validate=True)
        if not audio:
            raise ValueError('Inworld returned no audio')
        return audio, rate == speed, 'ogg'
    if provider == 'gemini':
        if effective_provider(provider) != provider:
            raise ValueError('Gemini free-tier cooldown is active')
        key = os.getenv('GEMINI_TTS_API_KEY', '')
        if not key:
            raise ValueError('Gemini speech key is missing')
        model = os.getenv('GEMINI_TTS_MODEL', 'gemini-3.8-flash-lite-tts')
        payload = {
                'contents': [{'parts': [{'text': text}]}],
                'generationConfig': {'responseModalities': ['AUDIO'], 'speechConfig': {
                    'voiceConfig': {'prebuiltVoiceConfig': {'voiceName': voice}}}}}
        chunks = []
        mime = ''
        async with client.stream('POST', 'https://generativelanguage.googleapis.com/v1beta/models/'+model+':streamGenerateContent',
                params={'alt': 'sse'}, headers={'x-goog-api-key': key}, json=payload, timeout=10) as response:
            if response.status_code == 429:
                await response.aread()
                delay = 60
                try:
                    for detail in response.json().get('error', {}).get('details', []):
                        value = detail.get('retryDelay', '')
                        if value.endswith('s'):
                            delay = max(60, min(86400, int(float(value[:-1]))))
                except (ValueError, TypeError):
                    pass
                global gemini_blocked_until
                gemini_blocked_until = time.monotonic() + delay
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith('data:'):
                    continue
                value = json.loads(line[5:])
                parts = value.get('candidates', [{}])[0].get('content', {}).get('parts', [])
                for part in parts:
                    if part.get('inlineData'):
                        inline = part['inlineData']
                        mime = inline.get('mimeType', mime)
                        chunks.append(base64.b64decode(inline['data']))
        if not chunks:
            raise ValueError('Gemini returned no audio')
        audio = b''.join(chunks)
        if 'audio/l16' in mime:
            sample_rate = int((re.search(r'rate=(\d+)', mime) or [None, '24000'])[1])
            out = io.BytesIO()
            with wave.open(out, 'wb') as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(sample_rate); output.writeframes(audio)
            audio = out.getvalue()
        return audio, False, 'wav'
    raise ValueError('Unknown TTS provider')
