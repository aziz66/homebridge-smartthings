import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { StatelessProgrammableSwitchService } from '../src/services/statelessProgrammableSwitchService';
import { CarbonMonoxideDetectorService } from '../src/services/carbonMonoxideDetector';
import { SecuritySystemService } from '../src/services/securitySystemService';
import { ShortEvent } from '../src/webhook/subscriptionHandler';
import { fakeAccessory, fakePlatform } from './helpers';
import { fakeMultiServiceAccessory, isCommFailure, makeService } from './devicesHelpers';

const C = hap.Characteristic;

function event(capability: string, attribute: string, eventValue: unknown): ShortEvent {
  return { deviceId: 'test', componentId: 'main', capability, attribute, value: eventValue } as ShortEvent;
}

// ---- stateless programmable switch ----

// Every ProgrammableSwitchEvent update is a button press to HomeKit, so record each one.
function makeButton(config: Record<string, unknown> = {}) {
  const made = makeService(StatelessProgrammableSwitchService, ['button'], {
    config, status: { button: { button: { value: 'held' } } },
  });
  const presses: hap.CharacteristicValue[] = [];
  made.service.getCharacteristic(C.ProgrammableSwitchEvent).on(hap.CharacteristicEventTypes.CHANGE, change => {
    presses.push(change.newValue);
  });
  return { ...made, presses };
}

test('a button is never polled, so the last press is not replayed as a phantom press', () => {
  assert.equal(makeButton().msa.polls.length, 0);
  assert.equal(makeButton({ PollSwitchesAndLightsSeconds: 5 }).msa.polls.length, 0);
});

test('reading ProgrammableSwitchEvent returns null and emits no press', async () => {
  const { service, presses } = makeButton();
  assert.equal(await service.getCharacteristic(C.ProgrammableSwitchEvent).handleGetRequest(), null);
  assert.deepEqual(presses, []);
});

test('button events map to HomeKit presses', () => {
  const E = C.ProgrammableSwitchEvent;
  const cases: Array<[unknown, number | undefined]> = [
    ['pushed', E.SINGLE_PRESS], ['down', E.SINGLE_PRESS],
    ['double', E.DOUBLE_PRESS], ['pushed_2x', E.DOUBLE_PRESS], ['down_2x', E.DOUBLE_PRESS], ['pushed_3x', E.DOUBLE_PRESS],
    ['held', E.LONG_PRESS], ['down_hold', E.LONG_PRESS], ['up_hold', E.LONG_PRESS],
    ['up', undefined], ['swipe_up', undefined], [null, undefined], [undefined, undefined], [3, undefined],
  ];
  for (const [inbound, expected] of cases) {
    const { instance, presses } = makeButton();
    assert.doesNotThrow(() => instance.processEvent(event('button', 'button', inbound)));
    assert.deepEqual(presses, expected === undefined ? [] : [expected], `button value ${String(inbound)}`);
  }
});

test('non-press button attributes are ignored', () => {
  const { instance, presses } = makeButton();
  instance.processEvent(event('button', 'numberOfButtons', 'pushed'));
  assert.deepEqual(presses, []);
});

// ---- carbon monoxide ----

test('a CO event updates CarbonMonoxideDetected, not CarbonDioxideDetected', () => {
  const { instance, service } = makeService(CarbonMonoxideDetectorService, ['carbonMonoxideDetector'],
    { config: { PollSensorsSeconds: 0 } });
  instance.processEvent(event('carbonMonoxideDetector', 'carbonMonoxide', 'detected'));
  assert.equal(service.getCharacteristic(C.CarbonMonoxideDetected).value, C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);
  assert.equal(service.testCharacteristic(C.CarbonDioxideDetected), false);

  instance.processEvent(event('carbonMonoxideDetector', 'carbonMonoxide', 'clear'));
  assert.equal(service.getCharacteristic(C.CarbonMonoxideDetected).value, C.CarbonMonoxideDetected.CO_LEVELS_NORMAL);
});

test('a stray CarbonDioxideDetected restored from the accessory cache is removed from the CO tile', () => {
  const accessory = fakeAccessory('CO sensor', ['carbonMonoxideDetector']);
  const cached = accessory.addService(hap.Service.CarbonMonoxideSensor);
  cached.addCharacteristic(C.CarbonDioxideDetected);

  new CarbonMonoxideDetectorService(fakePlatform({ PollSensorsSeconds: 0 }), accessory, 'main', ['carbonMonoxideDetector'],
    fakeMultiServiceAccessory() as never, 'CO sensor', { status: {} });

  assert.equal(accessory.getService(hap.Service.CarbonMonoxideSensor), cached);
  assert.equal(cached.testCharacteristic(C.CarbonDioxideDetected), false);
  assert.equal(cached.testCharacteristic(C.CarbonMonoxideDetected), true);
});

// ---- security system ----

const PANEL_STATUS = {
  securitySystem: {
    securitySystemStatus: { value: 'disarmed' },
    supportedSecuritySystemCommands: { value: ['armStay', 'armAway', 'armNight', 'disarm'] },
  },
};

test('a failed arm command restores the last settled state and fails the HomeKit write', async () => {
  const { instance, service } = makeService(SecuritySystemService, ['securitySystem'], {
    status: PANEL_STATUS, commandResult: false, config: { PollSecuritySystemsSeconds: 0 },
  });
  assert.equal(await instance.getCurrentState(), C.SecuritySystemCurrentState.DISARMED);

  await assert.rejects(instance.setTargetState(C.SecuritySystemTargetState.AWAY_ARM), isCommFailure);

  assert.equal(await instance.getTargetState(), C.SecuritySystemTargetState.DISARM);
  assert.equal(service.getCharacteristic(C.SecuritySystemTargetState).value, C.SecuritySystemTargetState.DISARM);
  assert.equal(service.getCharacteristic(C.SecuritySystemCurrentState).value, C.SecuritySystemCurrentState.DISARMED);
});

test('a successful arm command keeps the optimistic state', async () => {
  const { instance, service, msa } = makeService(SecuritySystemService, ['securitySystem'], {
    status: PANEL_STATUS, config: { PollSecuritySystemsSeconds: 0 },
  });
  await instance.setTargetState(C.SecuritySystemTargetState.AWAY_ARM);
  assert.equal(msa.commands[0].command, 'armAway');
  assert.equal(service.getCharacteristic(C.SecuritySystemCurrentState).value, C.SecuritySystemCurrentState.AWAY_ARM);
  assert.equal(msa.forcedRefreshes, 1);
});

test('valid target states are re-derived once the first status read reports supported commands', async () => {
  // At construction the component status is still empty, as in MultiServiceAccessory.
  const { instance, service, deviceStatus, msa } = makeService(SecuritySystemService, ['securitySystem'], {
    status: {}, config: { PollSecuritySystemsSeconds: 0 },
  });
  const validValues = () => service.getCharacteristic(C.SecuritySystemTargetState).props.validValues;
  assert.deepEqual(validValues(), [C.SecuritySystemTargetState.STAY_ARM, C.SecuritySystemTargetState.AWAY_ARM,
    C.SecuritySystemTargetState.DISARM]);

  deviceStatus.status = PANEL_STATUS;
  await instance.getCurrentState();

  assert.deepEqual(validValues(), [C.SecuritySystemTargetState.STAY_ARM, C.SecuritySystemTargetState.AWAY_ARM,
    C.SecuritySystemTargetState.NIGHT_ARM, C.SecuritySystemTargetState.DISARM]);

  await instance.setTargetState(C.SecuritySystemTargetState.NIGHT_ARM);
  assert.equal(msa.commands[0].command, 'armNight');
});
