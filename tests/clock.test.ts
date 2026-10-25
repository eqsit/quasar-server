import test from 'node:test'
import assert from 'node:assert/strict'
import proto from '../src/protos/protos'
import { setTimer, timerAction, setAlarm, cancelAlarm } from '../src/routers/alice/clock'

test('timer directives contain native protobuf data and duration in seconds', () => {
  const directive = setTimer(300, true, 'test-timer').quasarDirective!
  assert.equal(directive.DirectiveType, proto.NAlice.TCapability.EDirectiveType.TimerSetDirectiveType)
  const data = proto.NAlice.TAlarmCapability.TTimerSetDirective.decode(directive.PayloadRaw!)
  assert.equal(data.Timer?.TimerId, 'test-timer')
  assert.equal(data.Timer?.Duration, 300)
  assert.equal(data.Timer?.Paused, true)
  const cancelled = timerAction('cancel', 'test-timer').quasarDirective!
  assert.equal(proto.NAlice.TAlarmCapability.TTimerCancelDirective.decode(cancelled.PayloadRaw!).TimerId, 'test-timer')
})

test('alarm uses a local calendar date and Moscow time zone', () => {
  const directive = setAlarm('2036-10-25', 7, 30, 'test-alarm').quasarDirective!
  const data = proto.NAlice.TAlarmCapability.TAlarmAddDirective.decode(directive.PayloadRaw!)
  assert.equal(data.Alarm?.LocalTime?.Hours, 7)
  assert.equal(data.Alarm?.ActivationDays?.[0]?.Date?.Year, 2036)
  assert.equal(Number(data.Alarm?.Timezone?.OffsetSeconds), 10800)
  const cancelled = cancelAlarm('test-alarm').quasarDirective!
  assert.equal(proto.NAlice.TAlarmCapability.TAlarmCancelDirective.decode(cancelled.PayloadRaw!).AlarmId, 'test-alarm')
})
