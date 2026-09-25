import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { LockService } from '../src/services/lockService';
import { DoorService } from '../src/services/doorService';
import { ValveService } from '../src/services/valveService';
import { Battery } from '../src/services/batteryService';
import { WindowCoveringService } from '../src/services/windowCoveringService';
import { ShortEvent } from '../src/webhook/subscriptionHandler';
import { collectUnhandledRejections, isCommFailure, makeService } from './devicesHelpers';

const C = hap.Characteristic;

function value(service: hap.Service, characteristic: typeof C.LockCurrentState): hap.CharacteristicValue | null {
  return service.getCharacteristic(characteristic).value;
}

function event(capability: string, attribute: string, eventValue: unknown): ShortEvent {
  return { deviceId: 'test', componentId: 'main', capability, attribute, value: eventValue } as ShortEvent;
}

// ---- unguarded status reads ----

test('reading a lock, door, valve or battery with an empty status rejects instead of throwing', async () => {
  const rejections = await collectUnhandledRejections(async () => {
    const lock = makeService(LockService, ['lock']).instance;
    await assert.rejects(lock.getLockCurrentState(), isCommFailure);
    await assert.rejects(lock.getLockTargetState(), isCommFailure);

    const door = makeService(DoorService, ['doorControl']).instance;
    await assert.rejects(door.getCurrentDoorState(), isCommFailure);
    await assert.rejects(door.getTargetDoorState(), isCommFailure);

    const valve = makeService(ValveService, ['valve']).instance;
    await assert.rejects(valve.getValveState(), isCommFailure);

    const battery = makeService(Battery, ['battery']).instance;
    await assert.rejects(battery.getBatteryLevel(), isCommFailure);
    await assert.rejects(battery.getStatusLowBattery(), isCommFailure);
  });
  assert.deepEqual(rejections, []);
});

// ---- poll interval keys ----

test('locks poll on PollLocksSeconds, not PollSensorsSeconds', () => {
  assert.equal(makeService(LockService, ['lock'], { config: { PollLocksSeconds: 7 } }).msa.polls[0].pollSeconds, 7);
  assert.equal(makeService(LockService, ['lock'], { config: { PollSensorsSeconds: 3 } }).msa.polls[0].pollSeconds, 10);
  assert.equal(makeService(LockService, ['lock'], { config: { PollLocksSeconds: 0, PollSensorsSeconds: 3 } }).msa.polls.length, 0);
});

test('garage doors poll on PollDoorsSeconds, not PollSensorsSeconds', () => {
  assert.equal(makeService(DoorService, ['doorControl'], { config: { PollDoorsSeconds: 12 } }).msa.polls[0].pollSeconds, 12);
  assert.equal(makeService(DoorService, ['doorControl'], { config: { PollSensorsSeconds: 3 } }).msa.polls[0].pollSeconds, 10);
});

test('window shades and batteries default to their documented poll intervals', () => {
  assert.equal(makeService(WindowCoveringService, ['windowShade', 'windowShadeLevel']).msa.polls[0].pollSeconds, 20);
  assert.equal(makeService(Battery, ['battery']).msa.polls[0].pollSeconds, 10);
});

// ---- lock states ----

test('a lock reporting "not fully locked" is JAMMED', () => {
  const { instance, service } = makeService(LockService, ['lock']);
  instance.processEvent(event('lock', 'lock', 'not fully locked'));
  assert.equal(value(service, C.LockCurrentState), C.LockCurrentState.JAMMED);
});

test('an unknown lock event does not flip the target to UNSECURED', async () => {
  const { instance, service } = makeService(LockService, ['lock'], { status: { lock: { lock: { value: 'locked' } } } });
  instance.processEvent(event('lock', 'lock', 'locked'));
  instance.processEvent(event('lock', 'lock', 'unknown'));
  assert.equal(value(service, C.LockCurrentState), C.LockCurrentState.UNKNOWN);
  assert.equal(value(service, C.LockTargetState), C.LockTargetState.SECURED);

  instance.processEvent(event('lock', 'lock', 'unlocked'));
  assert.equal(value(service, C.LockTargetState), C.LockTargetState.UNSECURED);
});

test('a failed lock command fails the HomeKit write', async () => {
  const failing = makeService(LockService, ['lock'], { commandResult: false });
  await assert.rejects(failing.instance.setLockTargetState(C.LockTargetState.SECURED), isCommFailure);

  const working = makeService(LockService, ['lock']);
  await working.instance.setLockTargetState(C.LockTargetState.SECURED);
  assert.equal(working.msa.commands[0].command, 'lock');
  assert.equal(working.msa.forcedRefreshes, 1);
});

// ---- door states ----

test('an unknown door state shows STOPPED and leaves the target alone', async () => {
  const { instance, service } = makeService(DoorService, ['doorControl']);
  instance.processEvent(event('doorControl', 'door', 'closed'));
  assert.equal(value(service, C.TargetDoorState), C.TargetDoorState.CLOSED);

  instance.processEvent(event('doorControl', 'door', 'unknown'));
  assert.equal(value(service, C.CurrentDoorState), C.CurrentDoorState.STOPPED);
  assert.equal(value(service, C.TargetDoorState), C.TargetDoorState.CLOSED);

  const polled = makeService(DoorService, ['doorControl'], { status: { doorControl: { door: { value: 'unknown' } } } }).instance;
  assert.equal(await polled.getCurrentDoorState(), C.CurrentDoorState.STOPPED);
});

test('a failed door command fails the HomeKit write', async () => {
  const { instance } = makeService(DoorService, ['doorControl'], { commandResult: false });
  await assert.rejects(instance.setTargetDoorState(C.TargetDoorState.OPEN), isCommFailure);
});

// ---- valve ----

test('a valve ignores switch events from the switch+valve combo and pushes InUse with Active', () => {
  const { instance, service } = makeService(ValveService, ['switch', 'valve']);
  instance.processEvent(event('valve', 'valve', 'open'));
  assert.equal(value(service, C.Active), C.Active.ACTIVE);
  assert.equal(value(service, C.InUse), C.InUse.IN_USE);

  instance.processEvent(event('switch', 'switch', 'on'));
  assert.equal(value(service, C.Active), C.Active.ACTIVE);

  instance.processEvent(event('valve', 'valve', 'closed'));
  assert.equal(value(service, C.Active), C.Active.INACTIVE);
  assert.equal(value(service, C.InUse), C.InUse.NOT_IN_USE);
});

test('a failed valve or shade command fails the HomeKit write', async () => {
  await assert.rejects(makeService(ValveService, ['valve'], { commandResult: false }).instance
    .setValveState(C.Active.ACTIVE), isCommFailure);

  const rejections = await collectUnhandledRejections(async () => {
    await assert.rejects(makeService(WindowCoveringService, ['windowShade', 'windowShadeLevel'], { commandResult: false }).instance
      .setTargetPosition(50), isCommFailure);
  });
  assert.deepEqual(rejections, []);
});
