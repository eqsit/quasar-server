import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import proto from '../src/protos/protos'

// Paced VAD smoke test: streams a recorded utterance in real time instead of
// closing the stream immediately, so the server-side endpoint detector decides
// when the phrase is over. Prints endpoint / ASR / first-audio latencies.
const base = process.env.QUASAR_BASE_URL ?? 'wss://quasar.example.com:31117'
const route = fs.readFileSync(process.env.QUASAR_ROUTE_FILE ?? 'route.token', 'utf8').trim()
const audio = fs.readFileSync(process.env.QUASAR_VOICE_OGG ?? 'voice-favorites.ogg')
const socket = new WebSocket(`${base}/${route}/uniproxy.alice.yandex.net/uni.ws`, {
  headers: { 'x-uprx-device-id': 'test-vad-pacing' }
})
let lastAudioAt = 0
let asrAt = 0
let ttsAt = 0
let audioBytes = 0
let recognized = ''
const timer = setTimeout(() => { socket.terminate(); console.error('VAD test timed out'); process.exitCode = 1 }, 40000)

function send (message: proto.NAlice.NAliceApi.ITClientMessage) {
  socket.send(Buffer.concat([Buffer.from('AAPI'), proto.NAlice.NAliceApi.TClientMessage.encode(message).finish()]))
}

socket.on('open', async () => {
  send({ Event: { Header: { MessageId: randomUUID(), StreamId: 1 }, VoiceInput: {
    Header: { RequestId: randomUUID(), SequenceNumber: 1 },
    Request: { DeviceStateRaw: proto.NAlice.NAliceApi.TDeviceState.encode({ AudioPlayer: { PlayerState: 1 } }).finish() }
  } } })
  await new Promise(resolve => setTimeout(resolve, 150))
  send({ StreamControl: { StreamId: 1, MessageId: randomUUID(), SpotterEnd: {} } })
  const header = Buffer.alloc(4)
  header.writeUInt32BE(1)
  const chunks = 40
  const step = Math.ceil(audio.length / chunks)
  for (let offset = 0; offset < audio.length; offset += step) {
    socket.send(Buffer.concat([header, audio.subarray(offset, offset + step)]))
    lastAudioAt = Date.now()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
})

socket.on('message', raw => {
  const data = Buffer.from(raw as Buffer)
  if (data.subarray(0, 4).toString() !== 'AAPI') {
    audioBytes += data.length - 4
    if (!ttsAt) ttsAt = Date.now()
    return
  }
  const message = proto.NAlice.NAliceApi.TServerMessage.decode(data.subarray(4))
  const asr = message.Event?.AsrResult
  if (asr) {
    recognized = asr.Recognition?.map(x => x.Normalized).join(' ') ?? ''
    if (asr.EndOfUtt && !asrAt) asrAt = Date.now()
  }
  if (message.StreamControl?.Close && audioBytes > 0) {
    clearTimeout(timer)
    console.log(JSON.stringify({
      recognized,
      audioBytes,
      endpointMs: asrAt ? asrAt - lastAudioAt : null,
      firstAudioMs: ttsAt ? ttsAt - lastAudioAt : null,
      totalMs: Date.now() - lastAudioAt
    }))
    socket.close()
  }
})
socket.on('error', () => { clearTimeout(timer); console.error('VAD WebSocket failed'); process.exitCode = 1 })
