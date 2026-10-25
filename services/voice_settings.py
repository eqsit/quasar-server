"""Persistent voice preferences, isolated by Station device ID."""
import json
import os
from pathlib import Path
import tempfile
import re

VOICES = {
    'Alyona': 'Алёна', 'Elena': 'Елена', 'Oksana': 'Оксана', 'Tamara': 'Тамара',
    'Snezhana': 'Снежана', 'Yulia': 'Юлия', 'Polina': 'Полина', 'Svetlana': 'Светлана',
    'Galina': 'Галина', 'Grigory': 'Григорий', 'Yegor': 'Егор', 'Dmitry': 'Дмитрий',
    'Nikolai': 'Николай', 'Timofey': 'Тимофей', 'Rodion': 'Родион', 'Stepan': 'Степан',
    'Vadim': 'Вадим', 'Lev': 'Лев', 'Ruslan': 'Руслан', 'Arkady': 'Аркадий', 'Gleb': 'Глеб',
}


def voice_command(text):
    words = re.findall(r'[а-яa-z]+',text.lower().replace('ё','е'))
    for voice,name in VOICES.items():
        name = name.lower().replace('ё','е')
        forms = {name,voice.lower()}
        if name.endswith('ия'):
            forms.update(name[:-1]+ending for ending in ('и','ю','ей'))
        elif name.endswith('а'):
            forms.update(name[:-1]+ending for ending in ('ы','у','е','ой'))
        elif name.endswith('й'):
            forms.update(name[:-1]+ending for ending in ('я','ю','ем'))
        elif name == 'лев':
            forms.update(('льва','льву','львом'))
        else:
            forms.update(name+ending for ending in ('а','у','ом'))
        if not forms.intersection(words):
            continue
        voice_word = any(word.startswith('голос') for word in words)
        imperative = any(word.startswith(stem) for word in words for stem in
            ('постав','смени','сменить','поменя','измени','выбер','верни','переключ','говори','хочу','сделай'))
        if (len(words)==1 or (voice_word and (imperative or words[0].startswith('голос')))):
            return voice
    return None


class VoiceSettings:
    def __init__(self, path=None):
        self.path = Path(path or os.getenv('VOICE_SETTINGS_FILE', '/var/lib/quasar-voice/settings.json'))
        try:
            self.items = json.loads(self.path.read_text())
            if not isinstance(self.items, dict):
                raise ValueError('Invalid voice settings')
        except FileNotFoundError:
            self.items = {}

    def get(self, device, voice='Elena', speed=1.15):
        item = self.items.get(device, {})
        return {'voice': item.get('voice', voice), 'speed': item.get('speed', speed)}

    def set(self, device, voice=None, speed=None, delta_percent=None):
        if not device or len(device) > 128:
            raise ValueError('A Station device ID is required')
        item = self.get(device, os.getenv('TTS_VOICE','Elena'), float(os.getenv('TTS_DEFAULT_SPEED','1.15')))
        if voice is not None:
            if voice not in VOICES:
                raise ValueError('Unknown Russian voice')
            item['voice'] = voice
        if speed is not None:
            item['speed'] = float(speed)
        if delta_percent is not None:
            item['speed'] = round(item['speed'] + float(delta_percent)/100, 2)
        if not 0.5 <= item['speed'] <= 1.5:
            raise ValueError('Speaking rate must be between 50% and 150%')
        updated = {**self.items, device: item}
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile('w', dir=self.path.parent, delete=False) as f:
                name = f.name
                json.dump(updated, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.path)
        finally:
            if name and os.path.exists(name):
                os.unlink(name)
        self.items = updated
        return {**item, 'name': VOICES[item['voice']], 'saved': True}


settings = VoiceSettings()
