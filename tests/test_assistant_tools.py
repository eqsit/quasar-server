import asyncio
import json
import unittest
import tempfile
from services.voice_settings import VoiceSettings
from unittest.mock import patch
import httpx
from services import assistant_tools as tools

class ToolTests(unittest.TestCase):
    def test_arithmetic_rejects_code_and_unbounded_exponents(self):
        self.assertEqual(tools.calculate('12*(3+4)'),84)
        for expression in ['__import__("os").getcwd()', '2**1000000', '1/0']:
            with self.assertRaises((ValueError, ZeroDivisionError)):
                tools.calculate(expression)

    def test_weather_uses_live_data_without_auth_headers(self):
        seen=[]
        def handle(request):
            seen.append(request)
            return httpx.Response(200,json={'current':{'temperature_2m':6.2},'daily':{'time':['2026-10-25','2026-10-26']}})
        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as c:
                result,_=await tools.execute_tool(c,'get_weather',{},'')
                self.assertEqual(result['current']['temperature_2m'],6.2)
                self.assertEqual(result['source'],'Open-Meteo')
        asyncio.run(main())
        self.assertEqual(seen[0].url.host,'api.open-meteo.com')
        self.assertNotIn('authorization',seen[0].headers)

    def test_music_lookup_error_does_not_schedule_playback(self):
        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _:httpx.Response(404))) as c:
                result,directives=await tools.execute_tool(c,'tidal_play',{'kind':'play','query':'missing'},'test')
                self.assertIn('error',result)
                self.assertEqual(directives,[])
        asyncio.run(main())

    def test_tool_result_reaches_model_before_final_answer(self):
        requests=[]
        async def complete(payload):
            requests.append(json.loads(json.dumps(payload)))
            if len(requests)==1:
                return {'choices':[{'message':{'role':'assistant','content':None,'tool_calls':[
                    {'id':'call1','type':'function','function':{'name':'calculate','arguments':'{"expression":"2+2"}'}}]}}]}
            self.assertEqual(payload['messages'][-1]['role'],'tool')
            self.assertEqual(json.loads(payload['messages'][-1]['content'])['result'],4)
            return {'choices':[{'message':{'role':'assistant','content':'Четыре'}}]}
        async def main():
            async with httpx.AsyncClient() as c:
                answer,directives=await tools.run_tools_turn(c,complete,[{'role':'user','content':'2+2'}],{}, {},'test')
                self.assertEqual(answer,'Четыре')
                self.assertEqual(directives,[])
        asyncio.run(main())

    def test_independent_searches_run_together_and_keep_result_order(self):
        active = 0
        calls = 0
        async def execute(*args):
            nonlocal active
            active += 1
            if active == 1:
                for _ in range(100):
                    if active == 2: break
                    await asyncio.sleep(0.001)
                self.assertEqual(active, 2)
            return {'query': args[2]['query']}, []
        async def complete(payload):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {'choices':[{'message':{'role':'assistant','tool_calls':[
                    {'id': str(i), 'function': {'name':'web_search','arguments':json.dumps({'query':str(i)})}}
                    for i in range(2)]}}]}
            self.assertEqual([m['tool_call_id'] for m in payload['messages'] if m.get('role')=='tool'], ['0','1'])
            return {'choices':[{'message':{'content':'Нашла ответ.'}}]}
        async def main():
            with patch.object(tools, 'execute_tool', execute):
                result,_ = await tools.run_tools_turn(None,complete,[],{}, {},'test',budget_seconds=5)
            self.assertEqual(result,'Нашла ответ.')
        asyncio.run(main())

    def test_slow_read_preserves_time_for_a_final_answer(self):
        calls = 0
        async def execute(*args):
            await asyncio.sleep(10)
        async def complete(payload):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {'choices':[{'message':{'role':'assistant','tool_calls':[
                    {'id':'read','function':{'name':'read_web_pages','arguments':'{"urls":["https://example.com"]}'}}]}}]}
            self.assertNotIn('tools',payload)
            self.assertIn('Новые функции недоступны',payload['messages'][-1]['content'])
            self.assertIn('error',json.loads(payload['messages'][-2]['content']))
            return {'choices':[{'message':{'content':'Страница не открылась, но в результатах поиска есть сведения.'}}]}
        async def main():
            with patch.object(tools,'execute_tool',execute):
                answer,_ = await tools.run_tools_turn(None,complete,[],{}, {},'test',budget_seconds=0.1)
            self.assertIn('результатах поиска',answer)
        asyncio.run(main())

    def test_radio_and_wave_use_the_current_song_without_playlist_search(self):
        async def complete(_): self.fail('Explicit track-radio command must not be rerouted by the LLM')
        seen=[]
        async def execute(client,name,args,device,state):
            seen.append((name,device))
            return {'count':98},[{'name':'smart_speaker_player_play','arguments':{}}]
        async def main():
            with patch.object(tools,'execute_tool',execute):
                for text in ['Включи радио по текущему треку','Вруби волну по этому треку']:
                    answer,directives=await tools.run_tools_turn(None,complete,[{'role':'user','content':text}],{}, {},'station')
                    self.assertTrue(directives)
                    self.assertIn('волну',answer)
        asyncio.run(main())
        self.assertEqual(seen,[('tidal_radio','station')]*2)

    def test_half_track_seek_uses_real_duration_without_a_model_roundtrip(self):
        async def complete(_):self.fail('Simple seeking must not wait for a language model')
        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(
                    lambda _:httpx.Response(200,json={'track':{'duration':294}}))) as client:
                for command,expected in [('Перемотай на половину',147),('Перемотай на 30 процентов',88.2)]:
                    _,directives=await tools.run_tools_turn(client,complete,[{'role':'user','content':command}],{}, {},'test')
                    self.assertEqual(directives[0]['arguments']['positionSeconds'],expected)
        asyncio.run(main())

    def test_voice_command_changes_real_selection_instead_of_relying_on_chat_history(self):
        async def complete(_):self.fail('Explicit voice selection must update settings directly')
        async def main():
            with tempfile.TemporaryDirectory() as directory:
                settings=VoiceSettings(directory+'/voices.json')
                settings.set('station',voice='Dmitry')
                with patch.object(tools,'voice_settings',settings):
                    answer,_=await tools.run_tools_turn(None,complete,[{'role':'user','content':'Поставь голос Елена'}],{}, {},'station')
                self.assertEqual(settings.get('station')['voice'],'Elena')
                self.assertIn('Елена',answer)
        asyncio.run(main())

if __name__=='__main__': unittest.main()
