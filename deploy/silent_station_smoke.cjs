// Workstation-only smoke test. Refuses to run unless both silent output guards are installed.
const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const WebSocket = require('ws')
const adb = process.env.ADB ?? 'adb'
const device = process.env.STATION_HOST ?? '192.168.1.100'
const config = JSON.parse(execFileSync(adb, ['-s', device + ':5555', 'shell', 'cat /system/vendor/quasar/quasar.cfg'], { encoding: 'utf8' }))
const alsa = execFileSync(adb, ['-s', device + ':5555', 'shell', 'cat /etc/asound.conf'], { encoding: 'utf8' })
if (config.audioclient.controller.playbackParams.common.gstProperties.SINK !== 'fakesink sync=true'
  || !alsa.includes('playback.pcm "quasar_silent"') || !alsa.includes('ttable.0.0 0') || !alsa.includes('ttable.1.1 0')) {
  throw new Error('Silent output guards are missing; test cancelled')
}
const sshHost = process.env.SERVER_SSH ?? 'quasar-host'
const ssh = cmd => execFileSync('ssh', [sshHost, cmd], { encoding: 'utf8' })
const duid = JSON.parse(ssh('curl -fsS http://127.0.0.1:31116/devices'))[0].duid
const token = JSON.parse(ssh(`curl -fsS 'http://127.0.0.1:31115/quasar.yandex.net/glagol/token?device_id=${duid}&platform=yandexmicro'`)).token
const since = '@' + Math.floor(Date.now() / 1000)
const ws = new WebSocket(`wss://${device}:1961`, { rejectUnauthorized: false })
let accepted = false
const timer = setTimeout(() => {
  ws.close()
  const logs = ssh(`journalctl -u quasar-server --since '${since}' --no-pager`)
  const synthesized = [...logs.matchAll(/Synthesized: (\d+)/g)].map(x => Number(x[1]))
  console.log(JSON.stringify({ accepted, ttsAudioBytes: synthesized, silentOutput: true }))
  if (!accepted || !synthesized.some(n => n > 0)) process.exitCode = 1
}, 18000)
ws.on('error', e => { clearTimeout(timer); console.error(e.message); process.exitCode = 1 })
ws.on('open', () => ws.send(JSON.stringify({ conversationToken: token, id: randomUUID(), payload: {
  command: 'sendText', text: 'Сколько будет два плюс два? Ответь одним словом.'
} })))
ws.on('message', d => {
  try { const r = JSON.parse(d); if (r.status === 'SUCCESS') accepted = true } catch {}
})
