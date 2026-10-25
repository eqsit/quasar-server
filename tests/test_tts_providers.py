import asyncio
import base64
import io
import json
import os
import unittest
from unittest.mock import patch
import wave
import httpx
from services import tts_providers as tts

class TTSTests(unittest.TestCase):
    def test_gemini_sse_chunks_become_one_valid_wav(self):
        pcm=b'\x10\x00'*2400
        def handle(request):
            self.assertEqual(request.url.host,'generativelanguage.googleapis.com')
            self.assertIn('streamGenerateContent',request.url.path)
            self.assertEqual(request.headers['x-goog-api-key'],'test-key')
            row={'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'audio/l16; rate=24000; channels=1','data':base64.b64encode(pcm).decode()}}]}}]}
            data=('data: '+json.dumps(row)+'\n\n')*2
            return httpx.Response(200,text=data,headers={'content-type':'text/event-stream'})
        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                audio,applied,container=await tts.synthesize(client,'gemini','Тест','Sulafat',1.3)
                self.assertFalse(applied)
                self.assertEqual(container,'wav')
                with wave.open(io.BytesIO(audio),'rb') as output:
                    self.assertEqual(output.getframerate(),24000)
                    self.assertEqual(output.readframes(4800),pcm+pcm)
        with patch.dict(os.environ,{'GEMINI_TTS_API_KEY':'test-key'}):
            asyncio.run(main())

    def test_voice_validation(self):
        self.assertTrue(tts.validate_voice('gemini','Sulafat'))
        self.assertTrue(tts.validate_voice('edge','ru-RU-SvetlanaNeural'))
        self.assertFalse(tts.validate_voice('gemini','../bad'))
        self.assertFalse(tts.validate_voice('cartesia','not-an-id'))
        self.assertTrue(tts.validate_voice('inworld','Alyona'))

    def test_inworld_uses_basic_credential_and_applies_speed_once(self):
        def handle(request):
            self.assertEqual(request.headers['authorization'],'Basic copied-credential')
            payload=json.loads(request.content)
            self.assertEqual(payload['audioConfig']['speakingRate'],1.15)
            self.assertEqual(payload['audioConfig']['audioEncoding'],'OGG_OPUS')
            self.assertEqual(payload['language'],'ru-RU')
            return httpx.Response(200,json={'audioContent':base64.b64encode(b'RIFFaudio').decode()})
        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                audio,applied,container=await tts.synthesize(client,'inworld','Тест','Alyona',1.15)
                self.assertEqual(audio,b'RIFFaudio')
                self.assertTrue(applied)
                self.assertEqual(container,'ogg')
        with patch.dict(os.environ,{'INWORLD_API_KEY':'copied-credential'}):
            asyncio.run(main())

if __name__=='__main__':unittest.main()

class QuotaFallbackTests(unittest.TestCase):
    def test_quota_cooldown_does_not_invalidate_voice_and_edge_still_speaks(self):
        import time
        from fastapi.testclient import TestClient
        from services import voice_api as api
        raw=io.BytesIO()
        with wave.open(raw,'wb') as output:
            output.setnchannels(1);output.setsampwidth(2);output.setframerate(24000);output.writeframes(b'\x00\x00'*2400)
        calls=[]
        original=tts.synthesize
        async def provider(client,name,text,voice,speed):
            calls.append(name)
            if name=='gemini':
                return await original(client,name,text,voice,speed)
            return raw.getvalue(),True,'wav'
        with patch.object(tts,'gemini_blocked_until',time.monotonic()+3600), \
                patch.object(api,'TTS_PROVIDER','gemini'),patch.object(tts,'synthesize',provider):
            self.assertTrue(tts.validate_voice('gemini','Sulafat'))
            self.assertEqual(tts.effective_provider('gemini'),'edge')
            with TestClient(api.app) as client:
                response=client.post('/v1/audio/speech',json={'input':'Проверка резервного голоса','voice':'Sulafat','response_format':'wav'})
                self.assertEqual(response.status_code,200)
                self.assertTrue(response.content.startswith(b'RIFF'))
        self.assertEqual(calls,['gemini','edge'])
