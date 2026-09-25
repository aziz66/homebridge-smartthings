import { API, Characteristic, WithUUID } from 'homebridge';

// Eve (Elgato) custom HomeKit characteristics for power/energy reporting.
// UUIDs validated against the fakegato-history reference. These render in the
// Eve app / Controller for HomeKit / Home+ — Apple's own Home app ignores them
// (its native Energy view is Matter-only; see src/matter/matterEnergyBridge.ts).
export const EVE_UUID = {
  CurrentConsumption: 'E863F10D-079E-48FF-8F27-9C2605A29F52', // instantaneous power, Watts
  TotalConsumption: 'E863F10C-079E-48FF-8F27-9C2605A29F52', // accumulated energy, kWh
  Voltage: 'E863F10A-079E-48FF-8F27-9C2605A29F52', // Volts
} as const;

export interface EveCharacteristics {
  CurrentConsumption: WithUUID<new () => Characteristic>;
  TotalConsumption: WithUUID<new () => Characteristic>;
  Voltage: WithUUID<new () => Characteristic>;
}

/**
 * Build the Eve power/energy characteristic classes against this Homebridge
 * instance's HAP. They are defined at runtime (rather than statically imported)
 * because the base class lives on `api.hap.Characteristic`.
 */
export function makeEveCharacteristics(api: API): EveCharacteristics {
  const { Characteristic: Base, Formats, Perms } = api.hap;

  const make = (displayName: string, uuid: string, unit: string, maxValue: number, minStep: number) =>
    class extends Base {
      static readonly UUID: string = uuid;
      constructor() {
        super(displayName, uuid, {
          format: Formats.FLOAT,
          unit: unit as unknown as undefined, // Eve units (W/kWh/V/A) aren't in the HAP Units enum
          minValue: 0,
          maxValue,
          minStep,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    } as unknown as WithUUID<new () => Characteristic>;

  return {
    CurrentConsumption: make('Current Consumption', EVE_UUID.CurrentConsumption, 'W', 65535, 0.1),
    TotalConsumption: make('Total Consumption', EVE_UUID.TotalConsumption, 'kWh', 1000000, 0.001),
    Voltage: make('Voltage', EVE_UUID.Voltage, 'V', 380, 0.1),
  };
}
