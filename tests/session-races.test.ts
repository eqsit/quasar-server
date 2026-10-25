import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ProcessorSession, ProcessorSessionEvents } from '../src/backend/backend'
import { getDirectiveFunctionProvider } from '../src/routers/alice/base-provider'
import { InputHandler } from '../src/routers/uniproxy/input-handler'

class Session extends EventEmitter<ProcessorSessionEvents> implements ProcessorSession {
  closed = false
  close () { this.closed = true; this.emit('close') }
  async prepare () {}
  async process () {}
}

test('a cancelled late session cannot replace or close the newer session', async () => {
  const resolve: ((s: ProcessorSession) => void)[] = []
  const handler = new InputHandler({ directiveFunctionProvider: getDirectiveFunctionProvider('test'),
    processor: { openSession: async () => await new Promise<ProcessorSession>(r => resolve.push(r)) } })
  const old = new Session(), current = new Session()
  const first = handler.openSession()
  handler.closeSession()
  const second = handler.openSession()
  resolve[1]!(current)
  await second
  resolve[0]!(old)
  await first
  assert.equal(old.closed, true)
  assert.equal(current.closed, false)
  current.emit('partialResponse', { text: 'current', directives: [], finished: true, shouldListen: false })
  assert.equal((await handler.getPartialResponse())?.text, 'current')
  handler.closeSession()
})
