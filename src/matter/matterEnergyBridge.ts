import { PlatformAccessory, Logger } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';

const MATTER_ISSUE_URL = 'https://github.com/homebridge/homebridge/issues/3942';

export interface EnergyReadings {
  powerW: number | null;
  energyKwh: number | null;
  voltageV: number | null;
}

/**
 * Forward-compatible Matter "ElectricalMeter" readiness shim.
 *
 * Apple Home's native Energy view (iOS 27+) is driven by Matter, not HAP — the
 * Eve characteristics only ever populate Eve-class apps. The `@matter/node`
 * library bundled with Homebridge ships the `ElectricalMeter` device type
 * (ElectricalPowerMeasurement + ElectricalEnergyMeasurement clusters), but
 * Homebridge does not yet expose the energy device types to plugins via
 * `api.matter.deviceTypes` (tracking: homebridge#3942).
 *
 * Everything that touches the (not-yet-final) Matter API is guarded, so a
 * partially-implemented or differently-shaped API can never crash the plugin —
 * worst case it logs at debug and falls back to Eve/HAP only. On every current
 * Homebridge build this is a guaranteed no-op.
 */
export class MatterEnergyBridge {
  private readonly log: Logger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly api: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private deviceType: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private node: any = null;
  private enabled = false;
  private active = false;

  constructor(platform: IKHomeBridgeHomebridgePlatform, private readonly label: string) {
    this.log = platform.log;
    this.api = platform.api;
  }

  /** Feature-detect the Matter energy device type. Returns false (no-op) when absent. */
  detect(): boolean {
    const deviceTypes = this.api && this.api.matter && this.api.matter.deviceTypes;
    if (!deviceTypes) {
      this.log.debug('[matter] api.matter.deviceTypes not available on this Homebridge build — ' +
        `Matter energy export disabled. Tracking: ${MATTER_ISSUE_URL}`);
      return false;
    }
    // Accept either capitalization in case the final API name differs.
    const meter = deviceTypes.ElectricalMeter || deviceTypes.electricalMeter || null;
    if (!meter) {
      this.log.debug('[matter] api.matter.deviceTypes present but ElectricalMeter not yet exposed — ' +
        `Matter energy export disabled. Tracking: ${MATTER_ISSUE_URL}`);
      return false;
    }
    this.deviceType = meter;
    this.enabled = true;
    return true;
  }

  /** Register the accessory as a Matter ElectricalMeter, if a publish entry point exists. */
  register(accessory: PlatformAccessory, readings: EnergyReadings): boolean {
    if (!this.enabled) {
      return false;
    }
    try {
      // The registration entry point is not finalized upstream (#3942), so probe
      // the most likely candidates and bail cleanly if none exist.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acc = accessory as any;
      const publish =
        (this.api.matter && typeof this.api.matter.publishDevice === 'function')
          ? this.api.matter.publishDevice.bind(this.api.matter)
          : (typeof acc.configureMatterDevice === 'function')
            ? acc.configureMatterDevice.bind(acc)
            : null;

      if (!publish) {
        this.log.info('[matter] ElectricalMeter device type is available but no registration entry point ' +
          `was found on this build. Skipping Matter export for "${this.label}" — finalize against ${MATTER_ISSUE_URL}.`);
        return false;
      }

      this.node = publish({ deviceType: this.deviceType, clusters: this.buildClusters(readings) });
      this.active = true;
      this.log.info(`[matter] Registered "${this.label}" as a Matter ElectricalMeter — ` +
        'it will appear in the Apple Home Energy view.');
      return true;
    } catch (err) {
      this.log.warn(`[matter] Failed to register Matter ElectricalMeter for "${this.label}" ` +
        `(${err && (err as Error).message ? (err as Error).message : err}). Falling back to Eve/HAP only.`);
      this.active = false;
      return false;
    }
  }

  /** Push fresh readings to the Matter clusters. No-op unless registration succeeded. */
  update(readings: EnergyReadings): void {
    if (!this.active || !this.node) {
      return;
    }
    try {
      if (typeof this.node.update === 'function') {
        this.node.update(this.buildClusters(readings));
      }
    } catch (err) {
      this.log.debug(`[matter] update skipped: ${err && (err as Error).message ? (err as Error).message : err}`);
    }
  }

  // Matter electrical clusters use milli-units. Missing/NaN readings degrade to 0.
  private buildClusters(r: EnergyReadings) {
    const milli = (x: number | null, scale: number) => Math.round((x || 0) * scale);
    return {
      electricalPowerMeasurement: {
        voltage: milli(r.voltageV, 1000), // V → mV
        activePower: milli(r.powerW, 1000), // W → mW
      },
      electricalEnergyMeasurement: {
        cumulativeEnergyImported: {
          energy: milli(r.energyKwh, 1_000_000), // kWh → mWh
        },
      },
    };
  }
}
