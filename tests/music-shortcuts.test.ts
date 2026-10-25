import test from 'node:test'
import assert from 'node:assert/strict'
import proto from '../src/protos/protos'
import { getDirectiveFunctionProvider } from '../src/routers/alice/base-provider'
import { InputHandler } from '../src/routers/uniproxy/input-handler'

test('one-word next while music is playing bypasses the language model', async () => {
  const handler = new InputHandler({
    directiveFunctionProvider: getDirectiveFunctionProvider('test'),
    processor: { async openSession () { throw new Error('Shortcut must not call an LLM') } }
  })
  const result = await handler.processVoiceInput({ text: 'Алиса, Следующий!', metadata: {
    deviceState: { AudioPlayer: { PlayerState: proto.NAlice.NAliceApi.TDeviceState.TAudioPlayer.TPlayerState.Playing } }
  } })
  assert.equal(result.directives[0]?.internalDirective?.type, 'music_next_track')
  assert.equal(result.text, null)
})

test('relative seeking uses milliseconds and absolute seeking distinguishes position from delta', async () => {
  const handler = new InputHandler({ directiveFunctionProvider: getDirectiveFunctionProvider('test'),
    processor: { async openSession () { throw new Error('Seek shortcut must not call an LLM') } } })
  const metadata = { deviceState: { AudioPlayer: { PlayerState: 2 } } }
  const restart = await handler.processVoiceInput({ text: 'В начало!', metadata })
  assert.deepEqual(restart.directives[0]?.internalDirective, { type: 'music_seek', positionMs: 0 })
  const absolute = await handler.processVoiceInput({ text: 'Перемотай на 2:10', metadata })
  assert.deepEqual(absolute.directives[0]?.internalDirective, { type: 'music_seek', positionMs: 130000 })
  const relative = await handler.processVoiceInput({ text: 'Назад на 2 минуты', metadata })
  assert.equal(relative.directives[0]?.quasarDirective?.Name, 'audio_player_rewind')
})
