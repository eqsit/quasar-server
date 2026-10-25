import json
import pathlib
import tempfile
import unittest
from services.voice_settings import VoiceSettings, voice_command


class VoiceSettingsTests(unittest.TestCase):
    def test_nominative_and_declined_voice_names_are_equivalent(self):
        for text in ['Голос Елена','Поставь голос Елена','Смени голос на Елену','Говори голосом Елены']:
            self.assertEqual(voice_command(text),'Elena')
        self.assertIsNone(voice_command('Расскажи про Елену'))
        self.assertIsNone(voice_command('Какие голоса есть?'))
    def test_voice_and_speed_survive_reload_and_are_isolated_by_device(self):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'settings.json'
            settings=VoiceSettings(path)
            settings.set('station1',voice='Polina',speed=1.15)
            settings.set('station1',delta_percent=10)
            restored=VoiceSettings(path)
            self.assertEqual(restored.get('station1'),{'voice':'Polina','speed':1.25})
            self.assertEqual(restored.get('station2'),{'voice':'Elena','speed':1.15})
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_invalid_voice_does_not_replace_a_saved_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'settings.json'
            settings=VoiceSettings(path)
            settings.set('station',voice='Elena')
            original=path.read_bytes()
            with self.assertRaises(ValueError): settings.set('station',voice='../wrong')
            self.assertEqual(path.read_bytes(),original)
