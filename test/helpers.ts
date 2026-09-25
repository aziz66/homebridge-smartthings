import * as hap from 'hap-nodejs';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';

// Minimal stand-ins for the Homebridge platform and logger, built on the real HAP types.
export const stubLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  success: () => undefined,
  log: () => undefined,
};

export function fakePlatform(config: Record<string, unknown> = {}) {
  return { Service: hap.Service, Characteristic: hap.Characteristic, config, log: stubLog, api: { hap } } as any;
}

// A real PlatformAccessory carrying the SmartThings device shape services read from context.
export function fakeAccessory(label: string, capabilities: string[]): PlatformAccessory {
  const accessory = new PlatformAccessory(label, hap.uuid.generate(label));
  accessory.context.device = { label, components: [{ id: 'main', capabilities: capabilities.map(id => ({ id })) }] };
  return accessory;
}
