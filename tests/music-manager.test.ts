import test from 'node:test'
import assert from 'node:assert/strict'
import { MusicManager } from '../src/music/manager'
import { MusicBackend } from '../src/backend/backend'

class Queue extends MusicBackend {
  index = 0
  async getCurrentTrack () { return { format: 'audio/mp4', url: 'https://example.test/current' } }
  async getNextTrack () { return { format: 'audio/mp4', url: 'https://example.test/next' } }
  async advanceQueueForward () { this.index++ }
  async advanceQueueBackward () { this.index-- }
}

test('lookahead uses next track and commits advancement only once', async () => {
  const backend = new Queue()
  const manager = new MusicManager(backend)
  const prepared = await manager.getNextTrack('test')
  assert.equal(prepared?.track.url, 'https://example.test/next')
  assert.equal(backend.index, 0)
  await manager.recoverCommit('test', prepared!.recoverCommitToken)
  await manager.recoverCommit('test', prepared!.recoverCommitToken)
  assert.equal(backend.index, 1)
})
