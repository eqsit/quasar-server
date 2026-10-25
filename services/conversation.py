"""Short-lived per-device dialogue history; no account tokens or audio are retained."""
import time
import re

class ConversationStore:
    def __init__(self, ttl=900, max_messages=16, clock=time.monotonic):
        self.ttl, self.max_messages, self.clock = ttl, max_messages, clock
        self.items = {}

    def history(self, device):
        item = self.items.get(device)
        if not item or self.clock() - item[0] > self.ttl:
            self.items.pop(device, None)
            return []
        return [dict(message) for message in item[1]]

    def remember(self, device, history):
        if len(self.items) >= 100:
            oldest = min(self.items, key=lambda key: self.items[key][0])
            self.items.pop(oldest, None)
        self.items[device] = (self.clock(), [dict(message) for message in history[-self.max_messages:]])


def should_listen(answer, user_text, directives=(), command=False):
    text = re.sub(r'^(?:эй\s+)?алиса[\s,!:.-]*', '', user_text.lower()).strip(' .,!?')
    if text in ('пока', 'спасибо', 'всё', 'все', 'хватит', 'стоп', 'до свидания',
                'ладно спасибо', 'всё спасибо', 'все спасибо', 'спокойной ночи', 'давай потом'):
        return False
    if text in ('не надо', 'нет спасибо', 'да не не надо', 'да не, не надо'):
        return False
    # A clarification still needs an answer, including an incomplete device command.
    if answer.rstrip(' \n\t»"').endswith('?'):
        return True
    if directives or command:
        return False
    # Brief utility queries and direct control commands end once fulfilled.
    if re.match(r'^(?:а\s+)?(?:какая\s+(?:сейчас\s+)?погода|погода\b|сколько\s+(?:сейчас\s+)?времени|'
                r'который\s+час|какое\s+(?:сегодня\s+)?число|какая\s+(?:сегодня\s+)?дата|'
                r'какой\s+сегодня\s+день)', text):
        return False
    if re.match(r'^(?:пожалуйста\s+)?(?:включи|выключи|поставь|останови|прибавь|убавь|'
                r'громкость|потише|погромче|следующий|предыдущий|таймер|будильник|говори|'
                r'скорость\s+речи|смени\s+голос|поменяй\s+голос)\b', text):
        return False
    return True
