import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { OpusProcessor } from '../src/codecs/opus-processor'
import { OggParser } from '../src/codecs/ogg-parser'

test('fragmented Ogg pages and multi-segment Opus packets decode identically at 16 kHz', async () => {
  const encoded = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=500:duration=0.6', '-ar', '24000', '-ac', '1', '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1'])
  assert.equal(encoded.status, 0, encoded.stderr.toString())
  assert.ok(OggParser.parse(encoded.stdout).some(page => page.segments.some(segment => segment.length === 255)))
  const decoded: Buffer[][] = [[], []]
  for (const [index, chunkSize] of [encoded.stdout.length, 17].entries()) {
    const processor = new OpusProcessor(async pcm => { decoded[index]!.push(pcm) }, async rate => { assert.equal(rate, 16000) })
    for (let offset = 0; offset < encoded.stdout.length; offset += chunkSize) {
      await processor.handleAudioData(encoded.stdout.subarray(offset, offset + chunkSize))
    }
  }
  const full = Buffer.concat(decoded[0]!)
  assert.ok(full.length >= 16000 * 0.6 * 2)
  assert.deepEqual(Buffer.concat(decoded[1]!), full)
})
