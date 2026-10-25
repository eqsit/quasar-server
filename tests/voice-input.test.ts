import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMetadataBackendSession, STTBackendSession } from '../src/backend/backend'
import { VoiceInputHandler } from '../src/routers/uniproxy/voice-input-handler'

class Metadata extends AudioMetadataBackendSession {
  close (): void {}
  async finish (): Promise<object> { return {} }
  async processChunk (): Promise<void> {}
}

class BufferedSTT extends STTBackendSession {
  closed = false
  close (): void { this.closed = true }
  transcribeChunk (_chunk: Buffer): void {}
  override async finish (): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 20))
    this.chunkTranscribed({ text: 'Готовый текст', endOfUtt: true })
  }
}

test('explicit Finish waits for buffered STT and emits exactly one result', async () => {
  const stt = new BufferedSTT()
  const handler = new VoiceInputHandler({
    audioMetadata: { startCapturing: async () => new Metadata() },
    stt: { startTranscribing: async () => stt }
  })
  const results: string[] = []
  let metadata: object = {}
  handler.on('finish', event => results.push(event.text))
  handler.on('finish', event => { metadata = event.metadata })
  await handler.handleVoiceInputEvent({ metadata: { deviceId: 'station-test' } })
  await Promise.all([handler.handleVoiceInputFinishEvent({}), handler.handleVoiceInputFinishEvent({})])
  assert.deepEqual(results, ['Готовый текст'])
  assert.equal(stt.closed, true)
  assert.deepEqual(metadata, { deviceId: 'station-test' })
})

test('cancel during buffered transcription does not emit a stale result', async () => {
  const stt = new BufferedSTT()
  const handler = new VoiceInputHandler({
    audioMetadata: { startCapturing: async () => new Metadata() },
    stt: { startTranscribing: async () => stt }
  })
  const results: string[] = []
  handler.on('finish', event => results.push(event.text))
  await handler.handleVoiceInputEvent({ metadata: {} })
  const pending = handler.handleVoiceInputFinishEvent({})
  await handler.handleVoiceInputCancelEvent({})
  await pending
  assert.deepEqual(results, [])
})

test('Finish waits for session startup and queued audio before flushing', async () => {
  const received: string[] = []
  class SlowSTT extends BufferedSTT {
    override async transcribeChunk (chunk: Buffer): Promise<void> {
      await new Promise(resolve => setTimeout(resolve, 15))
      received.push(chunk.toString())
    }
    override async finish (): Promise<void> {
      assert.deepEqual(received, ['first', 'second'])
      await super.finish()
    }
  }
  const stt = new SlowSTT()
  const handler = new VoiceInputHandler({
    audioMetadata: { startCapturing: async () => new Metadata() },
    stt: { startTranscribing: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return stt } }
  })
  const result: string[] = []
  handler.on('finish', e => result.push(e.text))
  const startup = handler.handleVoiceInputEvent({ metadata: { deviceId: 'slow-device' } })
  const first = handler.handleVoiceInputAudioEvent({ buffer: Buffer.from('first') })
  const second = handler.handleVoiceInputAudioEvent({ buffer: Buffer.from('second') })
  const ending = handler.handleVoiceInputFinishEvent({})
  await Promise.all([startup, first, second, ending])
  assert.deepEqual(result, ['Готовый текст'])
})
