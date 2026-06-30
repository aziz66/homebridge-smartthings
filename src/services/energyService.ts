import { PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { makeEveCharacteristics, EveCharacteristics } from '../characteristics/eveCharacteristics';
import { MatterEnergyBridge, EnergyReadings } from '../matter/matterEnergyBridge';

// Eve characteristic value ceilings (mirror the characteristic definitions).
const MAX_W = 65535;
const MAX_KWH = 1_000_000;
const MAX_V = 380;

/**
 * Exposes SmartThings power/energy as Eve custom characteristics (visible in the
 * Eve app / Controller / Home+ today) and, when Homebridge eventually exposes the
 * Matter energy device types, as a Matter ElectricalMeter (native Apple Home
 * Energy view). A single getReadings() feeds both paths.
 *
 * Scope: only attached to plug/switch/outlet accessories that already have a
 * Switch or Outlet host tile (see MultiServiceAccessory.addComponent). It never
 * synthesizes a tile, and TV/AC accessories are excluded.
 */
export class EnergyService extends BaseService {
  static readonly ENERGY_CAPABILITIES = ['powerMeter', 'energyMeter', 'powerConsumptionReport', 'voltageMeasurement'];

  private eve: EveCharacteristics;
  private readonly hasPower: boolean;
  private readonly hasEnergy: boolean;
  private readonly hasVoltage: boolean;
  private matter?: MatterEnergyBridge;
  private last: EnergyReadings = { powerW: null, energyKwh: null, voltageV: null };
  private lastEnergyUnit: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private primaryChar: any;
  private primaryGet: () => number = () => 0;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string,
    capabilities: string[], multiServiceAccessory: MultiServiceAccessory, name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.eve = makeEveCharacteristics(platform.api);
    this.hasPower = capabilities.includes('powerMeter') || capabilities.includes('powerConsumptionReport');
    this.hasEnergy = capabilities.includes('energyMeter') || capabilities.includes('powerConsumptionReport');
    this.hasVoltage = capabilities.includes('voltageMeasurement');

    // Attach to the device's existing on/off tile. addComponent only constructs this
    // service when a Switch/Outlet host exists on the main component, so the fallback
    // below is purely defensive and should not be reached in practice.
    const host = accessory.getService(platform.Service.Outlet) || accessory.getService(platform.Service.Switch);
    if (host) {
      this.service = host;
    } else {
      this.setServiceType(platform.Service.Outlet);
    }

    // Expose only the characteristics the device actually reports. The first one added
    // becomes the polling "primary" (its value is returned to startPollingState).
    if (this.hasPower) {
      this.addChar(this.eve.CurrentConsumption).onGet(() => this.eveVal(this.last.powerW, MAX_W));
      this.setPrimary(this.eve.CurrentConsumption, () => this.eveVal(this.last.powerW, MAX_W));
    }
    if (this.hasEnergy) {
      this.addChar(this.eve.TotalConsumption).onGet(() => this.eveVal(this.last.energyKwh, MAX_KWH));
      this.setPrimary(this.eve.TotalConsumption, () => this.eveVal(this.last.energyKwh, MAX_KWH));
    }
    if (this.hasVoltage) {
      this.addChar(this.eve.Voltage).onGet(() => this.eveVal(this.last.voltageV, MAX_V));
      this.setPrimary(this.eve.Voltage, () => this.eveVal(this.last.voltageV, MAX_V));
    }

    // Seed from any status already available — also captures the energyMeter unit so the
    // first webhook event (which carries no unit) converts correctly.
    this.refreshFromStatus();

    // Forward-compatible Matter ElectricalMeter shim (no-op until homebridge#3942).
    if (platform.config.EnableMatterEnergy === true) {
      this.matter = new MatterEnergyBridge(platform, name);
      if (this.matter.detect()) {
        this.matter.register(accessory, this.last);
      }
    }

    // Poll as a fallback to webhook events, on its own (slower) cadence so energy
    // doesn't ride the fast sensor poll. Reuses the shared polling plumbing (with its
    // in-flight-command guards): the primary char is updated via the return value,
    // the rest + Matter as a side effect of pollReadings().
    let pollSeconds = 30;
    if (platform.config.PollEnergySeconds !== undefined) {
      pollSeconds = platform.config.PollEnergySeconds;
    }
    if (pollSeconds > 0 && this.primaryChar) {
      multiServiceAccessory.startPollingState(pollSeconds, this.pollReadings.bind(this), this.service, this.primaryChar);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setPrimary(char: any, get: () => number): void {
    if (!this.primaryChar) {
      this.primaryChar = char;
      this.primaryGet = get;
    }
  }

  // Detect by UUID (not instanceof): makeEveCharacteristics builds fresh classes per
  // instance, so a cache-restored characteristic would otherwise be re-added every boot.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private addChar(cls: any): Characteristic {
    const existing = this.service.characteristics.find(c => c.UUID === cls.UUID);
    return existing ?? this.service.addCharacteristic(cls);
  }

  // Coerce a reading into a HAP-legal Eve value in [0, max] (rejects null/NaN/negative,
  // e.g. net-metering generation, which the Eve chars' minValue: 0 would otherwise reject).
  private eveVal(v: number | null, max: number): number {
    if (v === null || Number.isNaN(v)) {
      return 0;
    }
    return Math.min(max, Math.max(0, v));
  }

  private async pollReadings(): Promise<CharacteristicValue> {
    const ok = await this.getStatus();
    if (ok) {
      this.refreshFromStatus();
      this.pushAll();
    }
    return this.primaryGet();
  }

  private refreshFromStatus(): void {
    this.last = this.readFrom(this.deviceStatus.status);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readFrom(s: any): EnergyReadings {
    const pcr = s?.powerConsumptionReport?.powerConsumption?.value;
    const rawPower = pcr?.power ?? s?.powerMeter?.power?.value;

    let energyKwh: number | null = null;
    const em = s?.energyMeter?.energy;
    if (typeof em?.value === 'number') {
      this.lastEnergyUnit = em.unit; // remembered so webhook events (which carry no unit) convert correctly
      energyKwh = this.toKwh(em.value, em.unit);
    } else if (typeof pcr?.energy === 'number') {
      energyKwh = pcr.energy / 1000; // powerConsumptionReport energy is Wh
    }

    const rawVoltage = s?.voltageMeasurement?.voltage?.value;
    return {
      powerW: typeof rawPower === 'number' ? rawPower : null,
      energyKwh: typeof energyKwh === 'number' ? energyKwh : null,
      voltageV: typeof rawVoltage === 'number' ? rawVoltage : null,
    };
  }

  private toKwh(value: number, unit: string | undefined): number {
    return unit === 'Wh' ? value / 1000 : unit === 'mWh' ? value / 1_000_000 : value; // default kWh
  }

  // Push every exposed characteristic from cache, plus the Matter shim (raw values).
  private pushAll(): void {
    if (this.hasPower) {
      this.service.updateCharacteristic(this.eve.CurrentConsumption, this.eveVal(this.last.powerW, MAX_W));
    }
    if (this.hasEnergy) {
      this.service.updateCharacteristic(this.eve.TotalConsumption, this.eveVal(this.last.energyKwh, MAX_KWH));
    }
    if (this.hasVoltage) {
      this.service.updateCharacteristic(this.eve.Voltage, this.eveVal(this.last.voltageV, MAX_V));
    }
    this.matter?.update(this.last);
  }

  public processEvent(event: ShortEvent): void {
    const next: EnergyReadings = { ...this.last };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = event.value as any;
    switch (event.capability) {
      case 'powerConsumptionReport':
        if (value && typeof value === 'object') {
          if (typeof value.power === 'number') {
            next.powerW = value.power;
          }
          if (typeof value.energy === 'number') {
            next.energyKwh = value.energy / 1000; // Wh → kWh
          }
        }
        break;
      case 'powerMeter':
        if (typeof value === 'number') {
          next.powerW = value;
        }
        break;
      case 'energyMeter':
        if (typeof value === 'number') {
          next.energyKwh = this.toKwh(value, this.lastEnergyUnit); // honor the unit seen on the last status read
        }
        break;
      case 'voltageMeasurement':
        if (typeof value === 'number') {
          next.voltageV = value;
        }
        break;
      default:
        return;
    }
    this.last = next;
    this.log.debug(`Energy event for ${this.name}: ${event.capability} -> ${this.last.powerW}W`);
    this.pushAll();
  }
}
