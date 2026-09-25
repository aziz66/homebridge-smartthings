import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { AirConditionerService } from '../src/services/airConditionerService';
import { AirPurifierService } from '../src/services/airPurifierService';
import { ACLightingService } from '../src/services/acLightingService';
import { createClimateService, fakeMultiServiceAccessory } from './climateHelpers';
import { fakeAccessory, fakePlatform } from './helpers';

const AC_CAPS = ['switch', 'airConditionerMode', 'airConditionerFanMode', 'thermostatCoolingSetpoint',
  'temperatureMeasurement', 'fanOscillationMode'];

function acStatus(overrides: Record<string, unknown> = {}) {
  return {
    switch: { switch: { value: 'on' } },
    airConditionerMode: { airConditionerMode: { value: 'cool' } },
    airConditionerFanMode: { fanMode: { value: 'auto' } },
    thermostatCoolingSetpoint: { coolingSetpoint: { value: 24, unit: 'C' } },
    temperatureMeasurement: { temperature: { value: 26, unit: 'C' } },
    fanOscillationMode: { fanOscillationMode: { value: 'fixed' } },
    ...overrides,
  };
}

function createAc(status: Record<string, unknown> = acStatus()) {
  return createClimateService(AirConditionerService, AC_CAPS, status);
}

const event = (service: { processEvent: (e: unknown) => void }, capability: string, attribute: string, value: unknown) =>
  service.processEvent({ deviceId: 'd', componentId: 'main', capability, attribute, value });

// --- #2: no forced SmartThings refresh per read ---

test('AC reads do not force a status refresh', async () => {
  const { service, msa } = createAc();
  await service.getCurrentTemperature();
  await service.getTargetTemperature();
  await service.getTargetHeatingCoolingState();
  await service.getCurrentHeatingCoolingState();
  await service.getSwitchState();
  await service.getFanLevel();
  await service.getSwingMode();
  assert.equal(msa.counters.forceNextStatusRefresh, 0);
});

test('air purifier reads do not force a status refresh', async () => {
  const status = { switch: { switch: { value: 'on' } }, airConditionerFanMode: { fanMode: { value: 'auto' } } };
  const { service, msa } = createClimateService(AirPurifierService, ['switch', 'airConditionerFanMode'], status);
  await service.getActive();
  await service.getRotationSpeed();
  await service.getTargetAirPurifierState();
  assert.equal(msa.counters.forceNextStatusRefresh, 0);
});

test('AC lighting reads do not force a status refresh', async () => {
  const status = { 'samsungce.airConditionerLighting': { lighting: { value: 'on' } } };
  const { service, msa } = createClimateService(ACLightingService, ['samsungce.airConditionerLighting'], status);
  assert.equal(await service.getLightState(), true);
  assert.equal(msa.counters.forceNextStatusRefresh, 0);
});

// --- #3: Fahrenheit ---

function fahrenheitStatus() {
  return acStatus({
    thermostatCoolingSetpoint: { coolingSetpoint: { value: 72, unit: 'F' } },
    temperatureMeasurement: { temperature: { value: 77, unit: 'F' } },
  });
}

test('AC learns °F before getCurrentTemperature has run', async () => {
  const { service } = createAc(fahrenheitStatus());
  const target = await service.getTargetTemperature() as number;
  assert.ok(Math.abs(target - 22.22) < 0.01, `expected ~22.2 °C, got ${target}`);
  assert.equal(service.getTemperatureDisplayUnits(), hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
});

test('AC sends whole-degree °F setpoints, even before any read', async () => {
  const { service, msa } = createAc(fahrenheitStatus());
  await service.setTargetTemperature(22);
  const command = (msa.commands.at(-1) as Array<{ arguments: unknown[] }>)[0];
  assert.deepEqual(command.arguments, [72]); // not 71.6, and not 22
});

test('AC converts a cooling-setpoint event from °F before any read', () => {
  const { service, accessory } = createAc(fahrenheitStatus());
  event(service, 'thermostatCoolingSetpoint', 'coolingSetpoint', 68);
  const value = accessory.getService(hap.Service.Thermostat)!.getCharacteristic(hap.Characteristic.TargetTemperature).value as number;
  assert.equal(value, 20);
});

test('AC keeps Celsius setpoints unrounded', async () => {
  const { service, msa } = createAc();
  await service.getCurrentTemperature();
  await service.setTargetTemperature(23);
  assert.deepEqual((msa.commands.at(-1) as Array<{ arguments: unknown[] }>)[0].arguments, [23]);
});

// --- #4: fan speed mapping ---

const FAN_LISTS: string[][] = [
  ['auto', 'quiet', 'low', 'medium', 'high'],
  ['auto', 'low', 'medium', 'high'],
  ['auto', 'low', 'medium', 'high', 'turbo'],
  ['auto', '1', '2', '3'],
  ['auto', '1', '2', '3', '4', 'max'],
  ['auto', 'low', 'mid', 'high', 'turbo', 'sleep', 'quiet'],
];

for (const modes of FAN_LISTS) {
  test(`AC fan level round-trips every advertised mode: [${modes.join(', ')}] (#49)`, async () => {
    for (const mode of modes) {
      const status = acStatus({ airConditionerFanMode: { fanMode: { value: mode }, supportedAcFanModes: { value: modes } } });
      const { service } = createAc(status);
      const level = await service.getFanLevel() as number;
      if (mode === 'auto') {
        assert.equal(level, 0);
      }
      assert.equal(service.levelToFanMode(level), mode, `${mode} -> ${level}% -> ${service.levelToFanMode(level)}`);
    }
  });
}

test('AC mixed fan list no longer reads one step low (#49)', async () => {
  const modes = ['auto', 'quiet', 'low', 'medium', 'high'];
  const status = acStatus({ airConditionerFanMode: { fanMode: { value: 'low' }, supportedAcFanModes: { value: modes } } });
  const { service } = createAc(status);
  assert.equal(await service.getFanLevel(), 50);
});

test('AC without advertised fan modes keeps the legacy percentages', async () => {
  const expected = { auto: 0, low: 25, medium: 50, high: 75, turbo: 100 };
  for (const [mode, level] of Object.entries(expected)) {
    const { service } = createAc(acStatus({ airConditionerFanMode: { fanMode: { value: mode } } }));
    assert.equal(await service.getFanLevel(), level);
  }
});

// --- #10: swing ---

test('AC maps every non-fixed oscillation mode to SWING_ENABLED', async () => {
  const { service, accessory } = createAc();
  const swing = accessory.getService(hap.Service.Fanv2)!.getCharacteristic(hap.Characteristic.SwingMode);
  for (const [mode, expected] of [
    ['horizontal', hap.Characteristic.SwingMode.SWING_ENABLED],
    ['fixed', hap.Characteristic.SwingMode.SWING_DISABLED],
    ['all', hap.Characteristic.SwingMode.SWING_ENABLED],
    ['fixedCenter', hap.Characteristic.SwingMode.SWING_DISABLED],
    ['vertical', hap.Characteristic.SwingMode.SWING_ENABLED],
  ] as const) {
    event(service, 'fanOscillationMode', 'fanOscillationMode', mode);
    assert.equal(swing.value, expected, mode);
  }
  const { service: horizontal } = createAc(acStatus({ fanOscillationMode: { fanOscillationMode: { value: 'horizontal' } } }));
  assert.equal(await horizontal.getSwingMode(), hap.Characteristic.SwingMode.SWING_ENABLED);
});

// --- #11: TargetTemperature initial value ---

test('AC TargetTemperature starts inside its range, without a HAP warning', () => {
  const accessory = fakeAccessory('AC', AC_CAPS);
  const warnings: string[] = [];
  (accessory as any)._associatedHAPAccessory.on('characteristic-warning', (w: { message: string }) => warnings.push(w.message));
  new AirConditionerService(fakePlatform({ PollSensorsSeconds: 5 }), accessory, 'main', AC_CAPS,
    fakeMultiServiceAccessory(AC_CAPS) as any, 'AC', { status: acStatus() });
  const target = accessory.getService(hap.Service.Thermostat)!.getCharacteristic(hap.Characteristic.TargetTemperature);
  assert.equal(target.value, 16);
  assert.deepEqual(warnings.filter(m => m.includes('illegal value')), []);
});

// --- #5 / #8: air purifier ---

function createPurifier() {
  const status = {
    switch: { switch: { value: 'on' } }, // stale cache: still 'on' after the off command
    airConditionerFanMode: { fanMode: { value: 'low' }, supportedAcFanModes: { value: ['auto', 'low', 'medium', 'high'] } },
  };
  const created = createClimateService(AirPurifierService, ['switch', 'airConditionerFanMode'], status);
  const tile = created.accessory.getService(hap.Service.AirPurifier)!;
  return { ...created, tile };
}

test('air purifier: a quick off -> on is not skipped because of a stale cache', async () => {
  const { tile, msa } = createPurifier();
  const active = tile.getCharacteristic(hap.Characteristic.Active);
  active.updateValue(hap.Characteristic.Active.ACTIVE);
  await active.handleSetRequest(hap.Characteristic.Active.INACTIVE);
  await active.handleSetRequest(hap.Characteristic.Active.ACTIVE);
  const sent = msa.commands.map(c => (c as Array<{ command: string }>)[0].command);
  assert.deepEqual(sent, ['off', 'on']);
});

test('air purifier: a redundant on while already Active is still skipped', async () => {
  const { tile, msa } = createPurifier();
  const active = tile.getCharacteristic(hap.Characteristic.Active);
  active.updateValue(hap.Characteristic.Active.ACTIVE);
  await active.handleSetRequest(hap.Characteristic.Active.ACTIVE);
  assert.equal(msa.commands.length, 0);
});

test('air purifier: availableAcFanModes events are not treated as a fan mode', () => {
  const { service, tile } = createPurifier();
  const speed = tile.getCharacteristic(hap.Characteristic.RotationSpeed);
  const target = tile.getCharacteristic(hap.Characteristic.TargetAirPurifierState);
  event(service, 'airConditionerFanMode', 'fanMode', 'auto');
  assert.equal(target.value, 1);
  event(service, 'airConditionerFanMode', 'availableAcFanModes', ['auto', 'low']);
  assert.equal(target.value, 1);
  assert.equal(speed.value, 0);
  event(service, 'airConditionerFanMode', 'fanMode', 'high');
  assert.equal(target.value, 0);
  assert.equal(speed.value, 100);
});

test('air purifier: every manual fan mode survives the HomeKit round trip', () => {
  for (const modes of [['low', 'high'], ['low', 'medium', 'high'], ['low', 'mid', 'high', 'max'], ['1', '2', '3', '4', '5']]) {
    const status = { airConditionerFanMode: { fanMode: { value: modes[0] }, supportedAcFanModes: { value: ['auto', ...modes] } } };
    const { service } = createClimateService(AirPurifierService, ['switch', 'airConditionerFanMode'], status);
    for (const mode of modes) {
      const level = service.fanModeToLevel(mode);
      assert.equal(service.levelToFanMode(level), mode, `${mode} -> ${level}% in [${modes}]`);
    }
  }
});
