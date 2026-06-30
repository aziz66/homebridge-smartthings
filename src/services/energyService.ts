import { PlatformAccessory, CharacteristicValue, Characteristic } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { makeEveCharacteristics, EveCharacteristics } from '../characteristics/eveCharacteristics';
import { MatterEnergyBridge, EnergyReadings } from '../matter/matterEnergyBridge';

/**
 * Exposes SmartThings power/energy as Eve custom characteristics (visible in the
 * Eve app / Controller / Home+ today) and, when Homebridge eventually exposes the
 * Matter energy device types, as a Matter ElectricalMeter (native Apple Home
 * Energy view). A single getReadings() feeds both paths.
 *
 * Gated by config.ExposeEnergyMonitoring (see MultiServiceAccessory.addComponent).
 */
export class EnergyService extends BaseService {
  static readonly ENERGY_CAPABILITIES = ['powerMeter', 'energyMeter', 'powerConsumptionReport', 'voltageMeasurement'];

  private eve: EveCharacteristics;
  private totalChar = false;
  private voltageChar = false;
  private matter?: MatterEnergyBridge;
  private last: EnergyReadings = { powerW: null, energyKwh: null, voltageV: null };

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string,
    capabilities: string[], multiServiceAccessory: MultiServiceAccessory, name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding EnergyService to ${this.name} for [${capabilities.join(', ')}]`);
    this.eve = makeEveCharacteristics(platform.api);

    // Host the Eve characteristics on the device's existing on/off tile when present;
    // otherwise stand up an Outlet to carry them. (Switch→Outlet conversion for the
    // full Eve experience is handled in SwitchService via ExposeEnergyAsOutlet.)
    const host = accessory.getService(platform.Service.Outlet)
      || accessory.getService(platform.Service.Switch)
      || accessory.getService(platform.Service.Lightbulb);
    if (host) {
      this.service = host;
    } else {
      this.setServiceType(platform.Service.Outlet);
    }

    // Always expose instantaneous power; expose total/voltage only when reported.
    this.addChar(this.eve.CurrentConsumption).onGet(() => this.last.powerW ?? 0);
    if (capabilities.includes('energyMeter') || capabilities.includes('powerConsumptionReport')) {
      this.totalChar = true;
      this.addChar(this.eve.TotalConsumption).onGet(() => this.last.energyKwh ?? 0);
    }
    if (capabilities.includes('voltageMeasurement')) {
      this.voltageChar = true;
      this.addChar(this.eve.Voltage).onGet(() => this.last.voltageV ?? 0);
    }

    // Forward-compatible Matter ElectricalMeter shim (no-op until homebridge#3942).
    if (platform.config.EnableMatterEnergy === true) {
      this.matter = new MatterEnergyBridge(platform, name);
      if (this.matter.detect()) {
        this.refreshFromStatus();
        this.matter.register(accessory, this.last);
      }
    }

    // Poll as a fallback to webhook events. Reuses the shared polling plumbing
    // (with its in-flight-command guards); updates the primary char via the return
    // value and the secondary chars + Matter as a side effect.
    let pollSeconds = 30;
    if (platform.config.PollSensorsSeconds !== undefined) {
      pollSeconds = platform.config.PollSensorsSeconds;
    }
    if (pollSeconds > 0) {
      multiServiceAccessory.startPollingState(pollSeconds, this.pollReadings.bind(this), this.service,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.eve.CurrentConsumption as any);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private addChar(cls: any): Characteristic {
    return this.service.testCharacteristic(cls) ? this.service.getCharacteristic(cls) : this.service.addCharacteristic(cls);
  }

  private async pollReadings(): Promise<CharacteristicValue> {
    await this.getStatus();
    this.refreshFromStatus();
    this.pushSecondary();
    return this.last.powerW ?? 0;
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
      energyKwh = em.unit === 'Wh' ? em.value / 1000 : em.unit === 'mWh' ? em.value / 1_000_000 : em.value; // default kWh
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

  private pushSecondary(): void {
    if (this.totalChar && this.last.energyKwh !== null) {
      this.service.updateCharacteristic(this.eve.TotalConsumption, this.last.energyKwh);
    }
    if (this.voltageChar && this.last.voltageV !== null) {
      this.service.updateCharacteristic(this.eve.Voltage, this.last.voltageV);
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
          next.energyKwh = value; // event carries no unit; assume capability default kWh
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
    this.service.updateCharacteristic(this.eve.CurrentConsumption, this.last.powerW ?? 0);
    this.pushSecondary();
  }
}
