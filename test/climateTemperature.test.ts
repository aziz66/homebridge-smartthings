import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hap from 'hap-nodejs';
import { TemperatureService } from '../src/services/temperatureService';
import { RefrigeratorTemperatureService } from '../src/services/refrigeratorTemperatureService';
import { createClimateService } from './climateHelpers';

// PollSensorsSeconds 0: no read ever runs, so events are the only source of values.
const NO_POLL = { PollSensorsSeconds: 0 };

function createTemperature(status: Record<string, unknown>, Service: any = TemperatureService) {
  const created = createClimateService(Service, ['temperatureMeasurement'], status, {}, NO_POLL);
  const current = created.accessory.getService(hap.Service.TemperatureSensor)!.getCharacteristic(hap.Characteristic.CurrentTemperature);
  const event = (value: unknown, unit?: string) => created.service.processEvent({
    deviceId: 'd', componentId: 'main', capability: 'temperatureMeasurement', attribute: 'temperature', value,
    ...(unit ? { unit } : {}),
  });
  return { ...created, current, event };
}

test('temperature: a Celsius event is not converted as Fahrenheit before any read', () => {
  const { current, event } = createTemperature({ temperatureMeasurement: { temperature: { value: 21, unit: 'C' } } });
  event(22);
  assert.equal(current.value, 22);
});

test('temperature: a Fahrenheit device converts events', () => {
  const { current, event } = createTemperature({ temperatureMeasurement: { temperature: { value: 70, unit: 'F' } } });
  event(212);
  assert.equal(current.value, 100);
});

test('temperature: the event unit wins over the cached status unit', () => {
  const { current, event } = createTemperature({ temperatureMeasurement: { temperature: { value: 70, unit: 'F' } } });
  event(22, 'C');
  assert.equal(current.value, 22);
});

test('temperature: a read that sees °F switches the learned unit back to F', async () => {
  const status = { temperatureMeasurement: { temperature: { value: 21, unit: 'C' } } };
  const { service, current, event, deviceStatus } = createTemperature(status);
  await service.getSensorState(); // learns C
  deviceStatus.status = { temperatureMeasurement: { temperature: { value: 50, unit: 'F' } } };
  assert.equal(await service.getSensorState(), 10); // learns F
  deviceStatus.status = {}; // no cached unit: fall back to the learned one
  event(212);
  assert.equal(current.value, 100);
});

test('temperature: null / non-numeric events are ignored', () => {
  const { current, event } = createTemperature({ temperatureMeasurement: { temperature: { value: 21, unit: 'C' } } });
  event(22);
  event(null);
  event('n/a');
  assert.equal(current.value, 22);
});

test('refrigerator temperature: inherited event handling still converts with the right unit', () => {
  const { current, event } = createTemperature(
    { temperatureMeasurement: { temperature: { value: 37, unit: 'F' } } }, RefrigeratorTemperatureService);
  event(41);
  assert.equal(current.value, 5);
  event(null);
  assert.equal(current.value, 5);
});
