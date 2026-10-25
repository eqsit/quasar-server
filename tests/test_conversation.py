import unittest
from services.conversation import ConversationStore, should_listen

class ConversationTests(unittest.TestCase):
    def test_conversation_continues_but_commands_and_farewells_finish(self):
        self.assertTrue(should_listen('У меня отлично! А у тебя?', 'Как дела?'))
        self.assertFalse(should_listen('В Островцах шесть градусов.', 'Какая погода?'))
        self.assertFalse(should_listen('Ещё что-нибудь?', 'Спасибо'))
        self.assertTrue(should_listen('У меня всё хорошо.', 'Как дела?'))
        self.assertTrue(should_listen('По данным источника, вышло обновление.', 'Расскажи про новую уязвимость'))
        self.assertTrue(should_listen('Это связано с движением воздуха.', 'Почему меняется погода?'))
        self.assertFalse(should_listen('Включила музыку.', 'Включи любимые треки', [{'name':'play'}]))
        self.assertFalse(should_listen('Сейчас девять утра.', 'Сколько сейчас времени?'))
        self.assertFalse(should_listen('Готово.', 'Алиса, громкость пять'))
        self.assertTrue(should_listen('На сколько поставить таймер?', 'Поставь таймер'))
        self.assertFalse(should_listen('Готово.', 'Можешь выбрать голос Елены',command=True))

    def test_history_is_per_device_bounded_and_expires(self):
        now=[0]
        store=ConversationStore(ttl=900,max_messages=4,clock=lambda:now[0])
        history=[{'role':'user','content':str(i)} for i in range(6)]
        store.remember('a',history)
        self.assertEqual(len(store.history('a')),4)
        self.assertEqual(store.history('b'),[])
        now[0]=901
        self.assertEqual(store.history('a'),[])

if __name__=='__main__':unittest.main()
