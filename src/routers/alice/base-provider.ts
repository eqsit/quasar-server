import z from 'zod'

import { encodeProtobufStruct } from '../../protobuf'
import { AbstractDirectiveFunctionProvider, WrappedDirective } from './directives'
import { setTimer, timerAction, setAlarm, cancelAlarm } from './clock'

const bluetoothEnableDirective = {
  quasarDirective: {
    Name: 'start_bluetooth',
    Payload: {},
    Type: 'client_action'
  }
}

const bluetoothDisableDirective = {
  quasarDirective: {
    Name: 'stop_bluetooth',
    Payload: {},
    Type: 'client_action'
  }
}

const soundSetLevelDirective = (level: number) => ({
  quasarDirective: {
    IsLedSilent: true,
    Name: 'sound_set_level',
    Payload: encodeProtobufStruct({
      new_level: level,
      new_percent_level: level * 10
    }),
    Type: 'client_action'
  }
})

const playIotSoundDirective = (isPowerOn: boolean) => ({
  quasarDirective: {
    IsLedSilent: true,
    Name: 'local_audio_file_play',
    Payload: encodeProtobufStruct({
      play_times: 1,
      sound_to_play: isPowerOn ? 'AliceIoTSoundsTurnOn' : 'AliceIoTSoundsTurnOff'
    }),
    Type: 'client_action'
  }
})

const soundLouderDirective = {
  quasarDirective: {
    IsLedSilent: true,
    Name: 'sound_louder',
    Payload: {},
    Type: 'client_action'
  }
}

const soundQuieterDirective = {
  quasarDirective: {
    IsLedSilent: true,
    Name: 'sound_quiter',
    Payload: {},
    Type: 'client_action'
  }
}

export const playerStopDirective: WrappedDirective = {
  internalDirective: {
    type: 'music_stop'
  },
  quasarDirective: {
    IsLedSilent: true,
    Name: 'clear_queue',
    Payload: {},
    Type: 'client_action'
  }
}

const playerStartDirectve: WrappedDirective = {
  internalDirective: {
    type: 'music_play'
  }
}

const playerNextTrackDirective: WrappedDirective = {
  internalDirective: {
    type: 'music_next_track'
  }
}

const playerPreviousTrackDirective: WrappedDirective = {
  internalDirective: {
    type: 'music_previous_track'
  }
}

const playerRewindDirective = (amountMs: number, type: 'Backward' | 'Forward') => ({
  quasarDirective: {
    IsLedSilent: true,
    Name: 'audio_player_rewind',
    Payload: encodeProtobufStruct({
      amount_ms: amountMs,
      type
    }),
    Type: 'client_action'
  }
})

const playerSeekDirective = (positionSeconds: number): WrappedDirective => ({
  internalDirective: { type: 'music_seek', positionMs: Math.round(positionSeconds * 1000) }
})

export const textToDirectiveMap: Record<string, WrappedDirective> = {
  громче: soundLouderDirective,
  пауза: playerStopDirective,
  продолжи: playerStartDirectve,
  стоп: playerStopDirective,
  тише: soundQuieterDirective
}

export const musicShortcuts: Record<string, WrappedDirective> = {
  следующий: playerNextTrackDirective,
  следующая: playerNextTrackDirective,
  дальше: playerNextTrackDirective,
  'следующий трек': playerNextTrackDirective,
  'следующая песня': playerNextTrackDirective,
  назад: playerPreviousTrackDirective,
  предыдущий: playerPreviousTrackDirective,
  предыдущая: playerPreviousTrackDirective,
  'предыдущий трек': playerPreviousTrackDirective,
  пауза: playerStopDirective,
  продолжи: playerStartDirectve,
  продолжай: playerStartDirectve,
  'продолжи музыку': playerStartDirectve,
  сначала: playerSeekDirective(0),
  'в начало': playerSeekDirective(0),
  'с начала': playerSeekDirective(0),
  'перемотай в начало': playerSeekDirective(0)
}

export function musicSeekShortcut (command: string): WrappedDirective | undefined {
  const relative = /^(?:перемотай\s+)?(впер[её]д|назад)\s+на\s+(\d+)\s*(секунд[а-яё]*|минут[а-яё]*)$/u.exec(command)
  if (relative) return playerRewindDirective(Number(relative[2]) * (relative[3]!.startsWith('минут') ? 60000 : 1000),
    relative[1] === 'назад' ? 'Backward' : 'Forward')
  const absolute = /^перемотай\s+на\s+(\d+):(\d{1,2})$/u.exec(command)
  if (absolute && Number(absolute[2]) < 60) return playerSeekDirective(Number(absolute[1]) * 60 + Number(absolute[2]))
  return undefined
}

export function normalizeCommand (text: string): string {
  return text.toLowerCase().replace(/^\s*алиса[,\s]+/, '').replace(/[.,!?]+$/u, '').trim()
}

export class BaseDirectiveFunctionProvider extends AbstractDirectiveFunctionProvider {
  constructor () {
    super()

    this.addFunction('player_play', 'Resume the current Tidal queue; use tidal_play for new music', z.unknown(),
      () => playerStartDirectve)
    this.addFunction('player_pause', 'Pause music if it is playing', z.unknown(),
      () => playerStopDirective)
    this.addFunction('player_next_track', 'Switch to next track', z.unknown(),
      () => playerNextTrackDirective)
    this.addFunction('player_previous_track', 'Switch to previous track', z.unknown(),
      () => playerPreviousTrackDirective)
    this.addFunction('player_rewind', 'Seek FORWARD or BACKWARD by a relative duration, e.g. forward 30 seconds = 30000 ms. Preserve playback state.', z.object({
      amountMs: z.number().int().positive().describe('Amount to rewind in ms (always positive)'),
      direction: z.union([z.literal('Forward'), z.literal('Backward')])
    }), (data) => playerRewindDirective(data.amountMs, data.direction))
    this.addFunction('player_seek', 'Seek to an ABSOLUTE position in the current track. 2:10 = 130 seconds. 0 restarts the current song. Preserves pause.',
      z.object({ positionSeconds: z.number().min(0).max(86400) }), data => playerSeekDirective(data.positionSeconds))

    this.addFunction('bluetooth', 'Enable or disable Bluetooth on smart speaker', z.object({
      enable: z.boolean()
    }),
    (data) => data.enable ? bluetoothEnableDirective : bluetoothDisableDirective)
    this.addFunction('set_sound_volume_louder', 'Atomically make smart speaker volume louder', z.unknown(),
      () => soundLouderDirective)
    this.addFunction('set_sound_volume_quieter', 'Atomically make smart speaker volume quieter', z.unknown(),
      () => soundQuieterDirective)
    this.addFunction('set_sound_volume', 'Set volume on smart speaker', z.object({
      volume: z.number().int().min(0).max(10)
    }), (data) => soundSetLevelDirective(data.volume))
    this.addFunction('timer_set', 'Set a native timer on the Station; seconds is its duration',
      z.object({ seconds: z.number().int().min(1).max(86400) }), data => setTimer(data.seconds))
    for (const action of ['cancel', 'pause', 'resume'] as const) {
      this.addFunction(`timer_${action}`, `${action} an existing timer. Get IDs from get_clock_state first.`,
        z.object({ timerId: z.string().min(1).max(120) }), data => timerAction(action, data.timerId))
    }
    this.addFunction('alarm_set', 'Set a one-time native alarm. Use get_datetime to select the future local date.',
      z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59) }), data => setAlarm(data.date, data.hour, data.minute))
    this.addFunction('alarm_cancel', 'Cancel an existing alarm; get the alarm ID from get_clock_state.',
      z.object({ alarmId: z.string().min(1).max(120) }), data => cancelAlarm(data.alarmId))
    this.addFunction('play_iot_sound', 'Play IoT power on/power off sound on smart speaker', z.object({
      isPowerOn: z.boolean()
    })
      .describe('true if "on" sound, false if "off" sound'), (data) => playIotSoundDirective(data.isPowerOn))
  }
}

export function getDirectiveFunctionProvider (_platform: string) {
  return new BaseDirectiveFunctionProvider()
}
