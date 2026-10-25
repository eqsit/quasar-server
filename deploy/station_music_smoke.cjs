// Does not run unless the user has muted the Station. Always stops test playback.
const WS = require('ws')
const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const duid = process.env.STATION_DUID
if (!duid) throw new Error('Set STATION_DUID')
const sshHost = process.env.SERVER_SSH ?? 'quasar-host'
const stationHost = process.env.STATION_HOST ?? '192.168.1.100'
const ssh = command => execFileSync('ssh', [sshHost, command], { encoding: 'utf8' })
const token = JSON.parse(ssh(`curl -fsS 'http://127.0.0.1:31115/quasar.yandex.net/glagol/token?device_id=${duid}&platform=yandexmicro'`)).token
const ws = new WS(`wss://${stationHost}:1961`, { rejectUnauthorized: false })
const pending = new Map()
let state = {}
ws.on('message', raw => {
  const r = JSON.parse(raw)
  if (r.state) state = r.state
  const reference = r.requestId ?? r.id
  if (pending.has(reference)) { pending.get(reference)(r); pending.delete(reference) }
})
function request(payload) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Glagol request timed out')) }, 10000)
    pending.set(id, r => { clearTimeout(timer); if (r.status && r.status !== 'SUCCESS') reject(new Error('Glagol command failed')); else resolve(r) })
    ws.send(JSON.stringify({ conversationToken: token, id, payload }))
  })
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitState(playing, stage) {
  for (let attempt = 0; attempt < 24; attempt++) {
    await request({ command: 'ping' })
    if (state.volume !== 0) throw new Error('Volume is no longer muted')
    if (state.playing === playing) { console.log(stage, JSON.stringify({ playing: state.playing, volume: state.volume })); return }
    await delay(500)
  }
  throw new Error(stage + ': playback state did not change')
}
async function say(text) { await request({ command: 'sendText', text }) }
async function main() {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  await request({ command: 'ping' })
  if (state.volume !== 0) throw new Error('Station must be muted by the user before testing')
  try {
    await say('Включи Get Lucky группы Daft Punk в Tidal')
    await waitState(true, 'Tidal play')
    await say('пауза')
    await waitState(false, 'Tidal pause')
    await say('продолжи')
    await waitState(true, 'Tidal resume')
    await say('Следующий трек')
    for (let i=0; i<15; i++) {
      const q = JSON.parse(ssh(`curl -fsS http://127.0.0.1:31119/queue/${duid}/status`))
      if (q.index === 1) { console.log('Tidal next', JSON.stringify({ index: q.index, title: q.track?.title })); break }
      if (i===14) throw new Error('Next track did not advance queue')
      await delay(500)
    }
    await waitState(true, 'Tidal next playback')
    await say('Предыдущий трек')
    for (let i=0; i<20; i++) {
      const q = JSON.parse(ssh(`curl -fsS http://127.0.0.1:31119/queue/${duid}/status`))
      if (q.index === 0) { console.log('Tidal previous', JSON.stringify({ index: q.index, title: q.track?.title })); break }
      if (i===19) throw new Error('Previous track did not move queue')
      await delay(500)
    }
    await waitState(true, 'Tidal previous playback')
    const q = JSON.parse(ssh(`curl -fsS http://127.0.0.1:31119/queue/${duid}/status`))
    await say(`Перемотай текущую песню вперёд на ${q.track.duration - 3} секунд`)
    for (let i=0; i<35; i++) {
      const next = JSON.parse(ssh(`curl -fsS http://127.0.0.1:31119/queue/${duid}/status`))
      if (next.index === 1) { console.log('Tidal automatic next', JSON.stringify({ index: next.index, title: next.track?.title })); break }
      if (i===34) throw new Error('Automatic next track did not advance queue')
      await delay(500)
    }

  } finally {
    await say('стоп').catch(() => {})
    await waitState(false, 'Tidal stop').catch(() => {})
    ws.close()
  }
}
main().catch(error => { console.error(error.message); ws.terminate(); process.exitCode = 1 })
