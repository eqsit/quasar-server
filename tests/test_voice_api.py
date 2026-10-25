import struct
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from fastapi.testclient import TestClient
from services import voice_api as api


class DetectorTests(unittest.TestCase):
    def test_endpoint_after_speech_and_silence(self):
        d = api.EndpointDetector(classifier=lambda f, _: f != bytes(len(f)))
        speech = struct.pack('<h', 5000) * 480
        silence = bytes(960)
        self.assertFalse(d.feed(speech * 10))
        self.assertFalse(d.feed(silence * 39))
        self.assertTrue(d.feed(silence))
        self.assertEqual(d.voiced_ms, 300)

    def test_short_word_ends_after_silence(self):
        d = api.EndpointDetector(classifier=lambda f, _: f != bytes(len(f)))
        self.assertFalse(d.feed(struct.pack('<h', 5000) * 960))
        self.assertFalse(d.feed(bytes(960) * 39))
        self.assertTrue(d.feed(bytes(960)))
        self.assertEqual(d.voiced_ms, 60)
        self.assertLess(d.elapsed_ms, 1400)

    def test_old_silence_in_upload_does_not_hide_new_speech(self):
        d = api.EndpointDetector(classifier=lambda f, _: f != bytes(len(f)))
        speech = struct.pack('<h', 20) * 480
        self.assertFalse(d.feed(speech * 10 + bytes(960) * 30 + speech * 10))
        self.assertEqual(d.silence_ms, 0)

    def test_wake_word_boundary_discards_preroll(self):
        d = api.EndpointDetector(classifier=lambda *_: True)
        d.feed(struct.pack('<h', 20) * 16000)
        d.spotter_end()
        self.assertEqual(d.audio, b'')
        self.assertEqual(d.voiced_ms, 0)

    def test_split_frames_preserve_pcm(self):
        d = api.EndpointDetector(classifier=lambda *_: True)
        d.feed(bytes(400))
        self.assertEqual(d.voiced_ms, 0)
        d.feed(bytes(560))
        self.assertEqual(d.voiced_ms, 30)
        self.assertEqual(len(d.audio), 960)

    def test_no_speech_finishes_without_groq(self):
        d = api.EndpointDetector(classifier=lambda *_: False)
        self.assertTrue(d.feed(bytes(16000 * 2 * 6)))
        self.assertEqual(d.voiced_ms, 0)

    def test_unsupported_rate(self):
        with self.assertRaises(ValueError):
            api.EndpointDetector(44100)


class APITests(unittest.TestCase):
    def test_wake_word_does_not_complete_the_command(self):
        results = iter(['Алиса.', 'Как дела?'])
        async def transcribe(*args, **kwargs):
            return next(results)
        class VAD:
            def __init__(self, *a): pass
            def is_speech(self, *a): return False
        ticks = iter([0, 0, 2, 2, 4])
        with patch.object(api, 'transcribe', transcribe), patch.object(api.webrtcvad, 'Vad', VAD), \
                patch.object(api, 'time', SimpleNamespace(monotonic=lambda: next(ticks))):
            with TestClient(api.app) as client:
                with client.websocket_connect('/stt') as ws:
                    ws.send_json({'sample_rate': 16000})
                    ws.send_json({'type': 'spotter_end'})
                    ws.send_bytes(struct.pack('<h', 20) * 96000)
                    ws.send_bytes(struct.pack('<h', 20) * 96000)
                    self.assertEqual(ws.receive_json(), {'text': 'Как дела?', 'end_of_utt': True})
    def test_no_argument_tool_has_object_schema(self):
        tools = api.processor_tools({'pause': {'description': 'Pause', 'arguments': {
            '$schema': 'https://json-schema.org/draft/2020-12/schema'}}})
        self.assertEqual(tools[0]['function']['parameters'], {
            'type': 'object', 'properties': {}, 'additionalProperties': False})

    def test_tool_object_schema_preserves_required_arguments(self):
        schema = {'type': 'object', 'properties': {'volume': {'type': 'integer'}}, 'required': ['volume']}
        tools = api.processor_tools({'volume': {'arguments': schema}})
        self.assertEqual(tools[0]['function']['parameters'], schema)

    def test_explicit_finish_waits_for_transcript(self):
        calls = []
        pcm = struct.pack('<h', 20) * 4000
        async def transcribe(audio, *args, **kwargs):
            calls.append(audio)
            return 'Проверка распознавания'
        class VAD:
            def __init__(self, *a): pass
            def is_speech(self, *a): return True
        with patch.object(api, 'transcribe', transcribe), patch.object(api.webrtcvad, 'Vad', VAD):
            with TestClient(api.app) as client:
                with client.websocket_connect('/stt') as ws:
                    ws.send_json({'sample_rate': 16000})
                    ws.send_json({'type': 'spotter_end'})
                    ws.send_bytes(pcm)
                    ws.send_json({'sample_rate': 16000})
                    ws.send_bytes(pcm)
                    ws.send_json({'type': 'finish'})
                    self.assertEqual(ws.receive_json(), {'text': 'Проверка распознавания', 'end_of_utt': True})
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith(b'RIFF'))
        self.assertEqual(calls[0][44:], api.recognition_pcm(pcm * 2))

    def test_quiet_recording_is_transcribed_even_when_vad_rejects_it(self):
        calls = []
        async def transcribe(audio, *args, **kwargs):
            calls.append(audio)
            return 'Как дела?'
        class VAD:
            def __init__(self, *a): pass
            def is_speech(self, *a): return False
        with patch.object(api, 'transcribe', transcribe), patch.object(api.webrtcvad, 'Vad', VAD):
            with TestClient(api.app) as client:
                with client.websocket_connect('/stt') as ws:
                    ws.send_json({'sample_rate': 16000})
                    ws.send_json({'type': 'spotter_end'})
                    ws.send_bytes(struct.pack('<h', 20) * 8000)
                    ws.send_json({'type': 'finish'})
                    self.assertEqual(ws.receive_json()['text'], 'Как дела?')
        self.assertEqual(len(calls), 1)

    def test_empty_audio_is_not_sent_to_groq(self):
        with TestClient(api.app) as client:
            with client.websocket_connect('/stt') as ws:
                ws.send_json({'type': 'finish'})
                self.assertEqual(ws.receive_json(), {'text': '', 'end_of_utt': True})

    def test_rejects_invalid_tts_options(self):
        with TestClient(api.app) as client:
            self.assertEqual(client.post('/v1/audio/speech', json={'input': 'Тест', 'voice': 'invalid'}).status_code, 400)
            self.assertEqual(client.post('/v1/audio/speech', json={'input': 'Тест', 'speed': 9}).status_code, 422)

    def test_rejects_invalid_stt_model(self):
        with TestClient(api.app) as client:
            r = client.post('/v1/audio/transcriptions', data={'model': 'invalid'}, files={'file': ('a.wav', b'x')})
            self.assertEqual(r.status_code, 400)


if __name__ == '__main__':
    unittest.main()

class ProviderFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_connection_failure_becomes_bounded_api_error(self):
        import httpx
        def fail(request):
            raise httpx.ConnectError('unavailable')
        async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
            with self.assertRaises(api.HTTPException) as error:
                await api.provider_post('test',client,'https://test.invalid','private-test-key','/chat/completions',json={})
        self.assertEqual(error.exception.status_code,502)
        self.assertNotIn('private-test-key',str(error.exception))

class DeadlineTests(unittest.TestCase):
    def test_slow_provider_returns_voice_reply_before_station_timeout(self):
        import asyncio
        import os
        import time
        async def slow(*args, **kwargs):
            await asyncio.sleep(0.2)
            return {'choices':[{'message':{'role':'assistant','content':'too late'}}]}
        with patch.object(api,'provider_post',slow),patch.dict(os.environ,{
                'PROCESSOR_TIMEOUT_SECONDS':'0.02','VOICE_STREAMING':'0'}):
            with TestClient(api.app) as client:
                started=time.monotonic()
                with client.websocket_connect('/processor') as ws:
                    ws.send_json({'type':'prepare','data':{'directiveFunctions':{}}})
                    ws.send_json({'type':'process','data':{'text':'Проверь','metadata':{}}})
                    result=ws.receive_json()['data']
                    self.assertTrue(result['finished'])
                    self.assertIn('не получилось',result['text'])
                    self.assertLess(time.monotonic()-started,0.5)

class InterimTests(unittest.TestCase):
    def test_real_interim_arrives_before_final_recording_finish(self):
        self.check_interim(with_spotter=True)

    def test_followup_without_wake_word_receives_real_interim(self):
        self.check_interim(with_spotter=False)

    def check_interim(self, with_spotter):
        calls=[]
        async def transcribe(audio,*args,**kwargs):
            calls.append(audio)
            return 'Расскажи' if len(calls)==1 else 'Расскажи про уязвимость Яндекс Станции'
        class VAD:
            def __init__(self,*a):pass
            def is_speech(self,*a):return True
        with patch.object(api,'transcribe',transcribe),patch.object(api.webrtcvad,'Vad',VAD):
            with TestClient(api.app) as client:
                with client.websocket_connect('/stt') as ws:
                    ws.send_json({'sample_rate':16000})
                    if with_spotter:
                        ws.send_json({'type':'spotter_end'})
                    ws.send_bytes(struct.pack('<h',20)*16000)
                    first=ws.receive_json()
                    self.assertFalse(first['end_of_utt'])
                    self.assertEqual(first['text'],'Расскажи')
                    ws.send_bytes(struct.pack('<h',20)*16000)
                    ws.send_json({'type':'finish'})
                    final=ws.receive_json()
                    self.assertTrue(final['end_of_utt'])
                    self.assertIn('Яндекс Станции',final['text'])
        self.assertEqual(len(calls),2)
        self.assertGreater(len(calls[1]),len(calls[0]))


class StreamingCancelTests(unittest.TestCase):
    def test_interrupt_cancels_inflight_generation(self):
        import asyncio
        import threading
        cancelled = threading.Event()
        async def stream(client, url, payload, headers, on_sentence):
            try:
                await on_sentence('Первая часть ответа уже готова.')
                await asyncio.sleep(60)
            finally:
                cancelled.set()
        with patch.object(api, 'stream_completion', stream), patch.object(api, 'LLM_KEY', 'test-key'):
            with TestClient(api.app) as client:
                with client.websocket_connect('/processor') as ws:
                    ws.send_json({'type':'process','data':{'text':'Расскажи', 'metadata':{}}})
                    self.assertFalse(ws.receive_json()['data']['finished'])
                    ws.close()
                    self.assertTrue(cancelled.wait(1))


class SilenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_whisper_punctuation_and_low_confidence_silence_are_empty(self):
        for result in [{'text': '...'}, {'text': 'Продолжение следует.', 'segments': [
                {'no_speech_prob': 0.95, 'avg_logprob': -1.5}]}]:
            async def provider(*args, **kwargs): return result
            with patch.object(api, 'groq_post', provider):
                self.assertEqual(await api.transcribe(b'audio'), '')


class FollowupSilenceTests(unittest.TestCase):
    def test_brief_noise_after_tts_does_not_call_whisper_or_restart_a_dialogue(self):
        async def transcribe(*args, **kwargs):
            self.fail('Background click must not become a voice command')
        class VAD:
            def __init__(self, *a): self.frames=0
            def is_speech(self, *a):
                self.frames += 1
                return self.frames <= 3
        with patch.object(api, 'transcribe', transcribe), patch.object(api.webrtcvad, 'Vad', VAD):
            with TestClient(api.app) as client:
                with client.websocket_connect('/stt') as ws:
                    ws.send_json({'sample_rate':16000})
                    ws.send_bytes(struct.pack('<h',20)*16000)
                    ws.send_json({'type':'finish'})
                    self.assertEqual(ws.receive_json(), {'text':'', 'end_of_utt':True})
