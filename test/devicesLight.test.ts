import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { LightService } from '../src/services/lightService';
import { SwitchService } from '../src/services/switchService';
import { ShortEvent } from '../src/webhook/subscriptionHandler';
import { collectUnhandledRejections, isCommFailure, makeService } from './devicesHelpers';

const COLOR_LIGHT = ['switch', 'switchLevel', 'colorControl', 'colorTemperature'];

function colorTemperature(service: hap.Service): number {
  return service.getCharacteristic(hap.Characteristic.ColorTemperature).value as number;
}

test('a color light whose first status fetch fails does not raise an unhandled rejection at boot', async () => {
  const rejections = await collectUnhandledRejections(() => {
    makeService(LightService, COLOR_LIGHT, { cached: false, statusResult: false });
  });
  assert.deepEqual(rejections, []);
});

test('a color light with no colorControl status does not raise an unhandled rejection at boot', async () => {
  const rejections = await collectUnhandledRejections(() => {
    makeService(LightService, COLOR_LIGHT, { status: {} });
  });
  assert.deepEqual(rejections, []);
});

test('reading a light with an empty status rejects with a HAP error instead of throwing a TypeError', async () => {
  const { instance } = makeService(LightService, COLOR_LIGHT, { status: {} });
  for (const read of [instance.getSwitchState, instance.getLevel, instance.getColorTemp, instance.getHue, instance.getSaturation]) {
    await assert.rejects(read.call(instance), isCommFailure);
  }
});

test('color temperature is read as mireds = 1e6 / Kelvin, clamped to the characteristic range', async () => {
  const cases: Array<[number, number]> = [[2700, 370], [4000, 250], [6500, 154], [10000, 140], [1000, 500]];
  for (const [kelvin, mired] of cases) {
    const { instance } = makeService(LightService, COLOR_LIGHT, {
      status: { colorTemperature: { colorTemperature: { value: kelvin } } },
    });
    assert.equal(await instance.getColorTemp(), mired, `${kelvin}K`);
  }
});

test('color temperature is written as Kelvin = 1e6 / mireds', async () => {
  const { instance, msa } = makeService(LightService, COLOR_LIGHT);
  await instance.setColorTemp(370);
  await instance.setColorTemp(140);
  assert.deepEqual(msa.commands.map(c => c.args), [[2703], [7143]]);
  assert.equal(msa.commands[0].command, 'setColorTemperature');
});

test('a written color temperature is clamped to the device colorTemperatureRange when reported', async () => {
  const { instance, msa } = makeService(LightService, COLOR_LIGHT, {
    status: { colorTemperature: { colorTemperatureRange: { value: { minimum: 2700, maximum: 6500 } } } },
  });
  await instance.setColorTemp(500);   // 2000K
  await instance.setColorTemp(140);   // 7143K
  assert.deepEqual(msa.commands.map(c => c.args), [[2700], [6500]]);
});

test('a colorTemperature event pushes the event value, not the cached status', () => {
  const { instance, service } = makeService(LightService, COLOR_LIGHT, {
    status: { colorTemperature: { colorTemperature: { value: 2700 } } },
  });
  instance.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 4000 } as ShortEvent);
  assert.equal(colorTemperature(service), 250);

  // A colorTemperatureRange event or a junk value leaves it alone.
  instance.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperatureRange', value: { minimum: 1 } } as ShortEvent);
  instance.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperature', value: null } as ShortEvent);
  assert.equal(colorTemperature(service), 250);
});

test('turning a light on waits for the command and fails the HomeKit write when it fails', async () => {
  const failing = makeService(LightService, COLOR_LIGHT, { commandResult: false });
  await assert.rejects(failing.instance.setSwitchState(true), isCommFailure);
  await assert.rejects(failing.instance.setColorTemp(250), isCommFailure);
  assert.equal(failing.msa.forcedRefreshes, 0);

  const working = makeService(LightService, COLOR_LIGHT);
  await working.instance.setSwitchState(true);
  assert.equal(working.msa.forcedRefreshes, 1);
  assert.deepEqual(working.msa.commands[0], { componentId: 'main', capability: 'switch', command: 'on', args: undefined });
});

test('hue falls back to setColor and fails the write only when setColor fails too (#96)', async () => {
  const { instance, msa } = makeService(LightService, COLOR_LIGHT, { commandResult: false });
  await assert.rejects(instance.setHue(180), isCommFailure);
  assert.deepEqual(msa.commands.map(c => c.command), ['setHue', 'setColor']);
  assert.equal(instance.requireSetColor, true);

  msa.commandResult = true;
  await instance.setSaturation(50);
  assert.deepEqual(msa.commands.map(c => c.command), ['setHue', 'setColor', 'setColor']);
});

test('a switch write fails the HomeKit request when the command fails', async () => {
  const failing = makeService(SwitchService, ['switch'], { commandResult: false });
  await assert.rejects(failing.instance.setSwitchState(true), isCommFailure);

  const working = makeService(SwitchService, ['switch']);
  await working.instance.setSwitchState(false);
  assert.equal(working.msa.commands[0].command, 'off');
  assert.equal(working.msa.forcedRefreshes, 1);
});
