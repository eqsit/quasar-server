import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ProcessorSession, ProcessorSessionEvents } from '../src/backend/backend'
import { getDirectiveFunctionProvider } from '../src/routers/alice/base-provider'
import { InputHandler } from '../src/routers/uniproxy/input-handler'

test('spoken progress keeps the processor alive and native continuation consumes the final answer once', async () => {
  let requests = 0, closed = false
  class Session extends EventEmitter<ProcessorSessionEvents> implements ProcessorSession {
    close () { closed = true; this.emit('close') }
    async prepare () {}
    async process () {
      requests++
      this.emit('partialResponse', { text: 'Сейчас посмотрю.', directives: [], finished: false })
    }
  }
  const session = new Session()
  const handler = new InputHandler({ directiveFunctionProvider: getDirectiveFunctionProvider('test'),
    processor: { async openSession () { return session } } })
  await handler.openSession()
  const progress = await handler.processVoiceInput({ text: 'Что нового?', metadata: {} })
  assert.equal(progress.text, 'Сейчас посмотрю.')
  assert.equal(progress.dialogFinished, false)
  assert.ok(progress.directives[0]?.quasarDirective?.OnFinish?.TypedCallbackRequest)
  assert.equal(closed, false)
  session.emit('partialResponse', { text: 'Нашла сведения.', directives: [], finished: true, shouldListen: false })
  const final = await handler.processTextInput({ data: { kind: 'continue' }, metadata: {} })
  assert.equal(final.text, 'Нашла сведения.')
  assert.equal(final.dialogFinished, true)
  assert.equal(requests, 1)
  assert.equal(closed, true)
  assert.equal(await handler.getPartialResponse(), null)
})

test('silence ends listening without sending an empty audio stream to the native player', async () => {
  class Session extends EventEmitter<ProcessorSessionEvents> implements ProcessorSession {
    close () { this.emit('close') }
    async prepare () {}
    async process () {
      this.emit('partialResponse', { text: '', directives: [], finished: true, shouldListen: false })
    }
  }
  const handler = new InputHandler({ directiveFunctionProvider: getDirectiveFunctionProvider('test'),
    processor: { async openSession () { return new Session() } } })
  await handler.openSession()
  const result = await handler.processVoiceInput({ text: '', metadata: {} })
  assert.equal(result.text, null)
  assert.equal(result.dialogFinished, true)
  assert.deepEqual(result.directives, [])
})
