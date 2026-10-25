import { randomUUID } from 'node:crypto'
import proto from '../../protos/protos'
import { WrappedDirective } from './directives'

const clock = proto.NAlice.TAlarmCapability
const types = proto.NAlice.TCapability.EDirectiveType

export function setTimer (seconds: number, paused = false, id: string = randomUUID()): WrappedDirective {
  return { quasarDirective: {
    Type: 'client_action', Name: 'timer_set_directive', DirectiveType: types.TimerSetDirectiveType,
    PayloadRaw: clock.TTimerSetDirective.encode({ Name: 'timer_set_directive', Timer: {
      TimerId: id, StartTimestamp: Date.now(), UpdateTimestamp: Date.now(),
      Duration: seconds, Remaining: seconds, Paused: paused,
      TimerType: proto.NAlice.NData.TTimerDescription.ETimerType.DEFAULT
    } }).finish()
  } }
}

export function timerAction (action: 'cancel' | 'pause' | 'resume', id: string): WrappedDirective {
  const parameters = { Name: `timer_${action}_directive`, TimerId: id }
  const entry = {
    cancel: { type: types.TimerCancelDirectiveType, encode: clock.TTimerCancelDirective.encode },
    pause: { type: types.TimerPauseDirectiveType, encode: clock.TTimerPauseDirective.encode },
    resume: { type: types.TimerResumeDirectiveType, encode: clock.TTimerResumeDirective.encode }
  }[action]
  return { quasarDirective: { Type: 'client_action', Name: parameters.Name,
    DirectiveType: entry.type, PayloadRaw: entry.encode(parameters).finish() } }
}

export function setAlarm (date: string, hour: number, minute: number, id: string = randomUUID()): WrappedDirective {
  const parts = date.split('-').map(Number)
  const instant = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid alarm calendar date')
  }
  return { quasarDirective: {
    Type: 'client_action', Name: 'alarm_add_directive', DirectiveType: types.AlarmAddDirectiveType,
    PayloadRaw: clock.TAlarmAddDirective.encode({ Name: 'alarm_add_directive', Alarm: {
      AlarmId: id, LocalTime: { Hours: hour, Minutes: minute, Seconds: 0 },
      Timezone: { TimezoneName: 'Europe/Moscow', OffsetSeconds: 10800 },
      ActivationDays: [{ Date: { Year: parts[0]!, Month: parts[1]!, Day: parts[2]! } }],
      Disabled: false, EditTimestamp: Date.now()
    } }).finish()
  } }
}

export function cancelAlarm (id: string): WrappedDirective {
  return { quasarDirective: {
    Type: 'client_action', Name: 'alarm_cancel_directive', DirectiveType: types.AlarmCancelDirectiveType,
    PayloadRaw: clock.TAlarmCancelDirective.encode({ Name: 'alarm_cancel_directive', AlarmId: id }).finish()
  } }
}
