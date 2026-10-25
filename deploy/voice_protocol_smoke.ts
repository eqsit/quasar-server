import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import proto from '../src/protos/protos'
const base = process.env.QUASAR_BASE_URL ?? 'wss://quasar.example.com:31117'
const route = fs.readFileSync(process.env.QUASAR_ROUTE_FILE ?? 'route.token', 'utf8').trim()
const nextMode = process.argv.includes('--next')
const audio = fs.readFileSync(process.env.QUASAR_VOICE_OGG ?? (nextMode ? 'voice-next.ogg' : 'voice-favorites.ogg'))
const socket = new WebSocket(`${base}/${route}/uniproxy.alice.yandex.net/uni.ws`, {
  headers: { 'x-uprx-device-id': 'test-voice-protocol' }
})
const started = Date.now()
let recognized = '', answer = '', music = false, audioBytes = 0
const timer = setTimeout(() => { socket.terminate(); console.error('Protocol test timed out'); process.exitCode = 1 }, 45000)
function send (message: proto.NAlice.NAliceApi.ITClientMessage) {
  socket.send(Buffer.concat([Buffer.from('AAPI'), proto.NAlice.NAliceApi.TClientMessage.encode(message).finish()]))
}
socket.on('open', async () => {
  send({ Event: { Header: { MessageId: randomUUID(), StreamId: 1 }, VoiceInput: {
    Header: { RequestId: randomUUID(), SequenceNumber: 1 }, Request: { DeviceStateRaw: proto.NAlice.NAliceApi.TDeviceState.encode({ AudioPlayer: { PlayerState: nextMode ? 2 : 1 } }).finish() }
  } } })
  await new Promise(resolve => setTimeout(resolve, 150))
  send({ StreamControl: { StreamId: 1, MessageId: randomUUID(), SpotterEnd: {} } })
  const header = Buffer.alloc(4); header.writeUInt32BE(1)
  socket.send(Buffer.concat([header, audio]))
  send({ StreamControl: { StreamId: 1, MessageId: randomUUID(), Close: { Reason: 0 } } })
})
socket.on('message', raw => {
  const data = Buffer.from(raw as Buffer)
  if (data.subarray(0, 4).toString() !== 'AAPI') { audioBytes += data.length - 4; return }
  const message = proto.NAlice.NAliceApi.TServerMessage.decode(data.subarray(4))
  const asr = message.Event?.AsrResult
  if (asr) { recognized = asr.Recognition?.map(x => x.Normalized).join(' ') ?? ''; console.log('ASR', recognized) }
  const response = message.Event?.AliceResponse
  if (response) {
    answer = response.VoiceResponse?.OutputSpeech?.Text ?? ''; console.log('Answer', answer)
    music = response.Response?.Directives?.some(x => x.Name === 'audio_play') ?? false
    if (nextMode && !response.VoiceResponse?.HasVoiceResponse && music) { finish(); return }
  }
  if (message.StreamControl?.Close && audioBytes > 0) {
    finish()
  }
})
socket.on('error', () => { clearTimeout(timer); console.error('Protocol WebSocket failed'); process.exitCode = 1 })

function finish () {
  clearTimeout(timer)
  console.log(JSON.stringify({ recognized, answer, music, audioBytes, elapsedMs: Date.now() - started }))
  if (!recognized.toLowerCase().includes(nextMode ? 'следующ' : 'любим') || !music) process.exitCode = 1
  socket.close()
}
