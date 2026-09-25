import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { LightService } from '../src/services/lightService';
import { ShortEvent } from '../src/webhook/subscriptionHandler';
import { fakeAccessory, fakePlatform } from './helpers';

// Stands in for MultiServiceAccessory. Polling is disabled via config below, so the
// light only needs the online/status surface its handlers touch.
function fakeMultiServiceAccessory() {
  return {
    startPollingState: () => undefined,
    isOnline: () => true,
    hasCachedStatus: () => true,
    refreshStatus: async () => true,
  };
}

function makeLight() {
  const platform = fakePlatform({ PollSwitchesAndLightsSeconds: 0 });
  const accessory = fakeAccessory('Test Light', ['switch', 'switchLevel']);
  const light = new LightService(
    platform,
    accessory,
    'main',
    ['switch', 'switchLevel'],
    fakeMultiServiceAccessory() as never,
    'Test Light',
    { status: {} },
  );
  const service = accessory.getService(hap.Service.Lightbulb) as hap.Service;
  return { light, service };
}

function levelEvent(value: unknown): ShortEvent {
  return { deviceId: 'test', componentId: 'main', capability: 'switchLevel', attribute: 'level', value } as ShortEvent;
}

function brightness(service: hap.Service): number {
  return service.getCharacteristic(hap.Characteristic.Brightness).value as number;
}

// #56: SmartThings can report a switchLevel with no usable number. Pushing that to
// HomeKit throws a HAP warning and can blank the tile, so it must be ignored outright
// rather than coerced to 0.
for (const invalid of [null, undefined, 'abc', NaN, Infinity, -Infinity]) {
  test(`an invalid switchLevel event is ignored: ${String(invalid)} (#56)`, () => {
    const { light, service } = makeLight();
    service.updateCharacteristic(hap.Characteristic.Brightness, 42);

    light.processEvent(levelEvent(invalid));

    assert.equal(brightness(service), 42, 'brightness should keep its previous value');
  });
}

test('an out-of-range switchLevel event is clamped to 100 (#56)', () => {
  const { light, service } = makeLight();

  light.processEvent(levelEvent(150));

  assert.equal(brightness(service), 100);
});

test('a negative switchLevel event is clamped to 0 (#56)', () => {
  const { light, service } = makeLight();
  service.updateCharacteristic(hap.Characteristic.Brightness, 42);

  light.processEvent(levelEvent(-20));

  assert.equal(brightness(service), 0);
});

test('an in-range switchLevel event passes through unchanged (#56)', () => {
  const { light, service } = makeLight();

  light.processEvent(levelEvent(73));

  assert.equal(brightness(service), 73);
});

test('the range bounds are accepted as-is (#56)', () => {
  const { light, service } = makeLight();

  light.processEvent(levelEvent(0));
  assert.equal(brightness(service), 0);

  light.processEvent(levelEvent(100));
  assert.equal(brightness(service), 100);
});
