// Synthetic AAPI client: exercises native continuation without playing on a speaker.
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import proto from '../src/protos/protos'

const base = process.env.QUASAR_BASE_URL ?? 'wss://quasar.example.com:31117'
const route = fs.readFileSync(process.env.QUASAR_ROUTE_FILE ?? 'route.token', 'utf8').trim()
const socket = new WebSocket(`${base}/${route}/uniproxy.alice.yandex.net/uni.ws`, {
  headers: { 'x-uprx-device-id': 'test-streaming-protocol' }
})
let callback: proto.google.protobuf.IStruct | null = null
let dialogId: string | null = null
let parts = 0, audioBytes = 0, final = false
const start = Date.now()
const timeout = setTimeout(() => { socket.terminate(); console.error('Continuation timed out'); process.exitCode = 1 }, 35000)
function text (event: proto.NAlice.ITEvent) {
  const message: proto.NAlice.NAliceApi.ITClientMessage = { Event: {
    Header: { MessageId: randomUUID() }, TextInput: {
      Header: { RequestId: randomUUID(), SequenceNumber: 1, DialogId: dialogId },
      Request: { DeviceStateRaw: proto.NAlice.NAliceApi.TDeviceState.encode({}).finish(), Event: event }
    }
  } }
  socket.send(Buffer.concat([Buffer.from('AAPI'), proto.NAlice.NAliceApi.TClientMessage.encode(message).finish()]))
}
socket.on('open', () => text({ Type: proto.NAlice.EEventType.text_input,
  Text: 'Объясни в трёх коротких предложениях, зачем сохранять резервные копии.' }))
socket.on('message', raw => {
  const data = Buffer.from(raw as Buffer)
  if (data.subarray(0, 4).toString() !== 'AAPI') { audioBytes += data.length - 4; return }
  const message = proto.NAlice.NAliceApi.TServerMessage.decode(data.subarray(4))
  const response = message.Event?.AliceResponse
  if (response) {
    dialogId = response.Header?.DialogId ?? null
    parts++
    callback = response.Response?.Directives?.find(d => d.OnFinish?.TypedCallbackRequest)?.OnFinish?.TypedCallbackRequest ?? null
    final = callback === null
    console.log(JSON.stringify({ part: parts, seconds: (Date.now() - start) / 1000,
      continuation: !final, text: response.VoiceResponse?.OutputSpeech?.Text }))
  }
  for (const directive of message.Event?.Push?.Directives ?? []) {
    if (directive.Name === '@@mm_semantic_frame' && directive.Payload) {
      text({ Type: proto.NAlice.EEventType.server_action, Name: '@@mm_semantic_frame', Payload: directive.Payload })
    }
  }
  if (message.StreamControl?.Close) {
    if (callback) {
      const payload = callback; callback = null
      text({ Type: proto.NAlice.EEventType.server_action, Name: '@@mm_semantic_frame', Payload: payload })
    } else if (final) {
      clearTimeout(timeout)
      console.log(JSON.stringify({ parts, audioBytes, seconds: (Date.now() - start) / 1000 }))
      if (parts < 2 || audioBytes < 1000) process.exitCode = 1
      socket.close()
    }
  }
})
socket.on('error', () => { clearTimeout(timeout); console.error('Protocol connection failed'); process.exitCode = 1 })
