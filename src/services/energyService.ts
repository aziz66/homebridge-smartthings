import { PlatformAccessory, CharacteristicValue, Characteristic, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { makeEveCharacteristics, EveCharacteristics, EVE_UUID } from '../characteristics/eveCharacteristics';

export interface EnergyReadings {
  powerW: number | null;
  energyKwh: number | null;
  voltageV: number | null;
}

// Eve characteristic value ceilings (mirror the characteristic definitions).
const MAX_W = 65535;
const MAX_KWH = 1_000_000;
const MAX_V = 380;

/**
 * Exposes SmartThings power/energy as Eve custom characteristics, which render in
 * the Eve app, Controller for HomeKit and Home+.
 *
 * Apple's own Home app does NOT show these: its Energy view reads Matter, not HAP.
 * Homebridge 2.4+ does expose a Matter plugin API that would cover that case (an
 * OnOffOutlet declaring electricalPowerMeasurement / electricalEnergyMeasurement
 * cluster state, via api.matter.registerPlatformAccessories) - that is tracked as
 * separate work, deliberately not attempted here.
 *
 * Scope: only attached to plug/switch/outlet accessories that already have a
 * Switch, Outlet or Lightbulb host tile (see MultiServiceAccessory.addComponent).
 * It never synthesizes a tile, and TV/AC accessories are excluded.
 */
export class EnergyService extends BaseService {
  static readonly ENERGY_CAPABILITIES = ['powerMeter', 'energyMeter', 'powerConsumptionReport', 'voltageMeasurement'];

  // Capabilities that make a device a *metering* device. voltageMeasurement is deliberately
  // excluded: a voltage-only report is not grounds for republishing a Switch as an Outlet.
  static readonly METERING_CAPABILITIES = ['powerMeter', 'energyMeter', 'powerConsumptionReport'];

  private eve: EveCharacteristics;
  private readonly hasPower: boolean;
  private readonly hasEnergy: boolean;
  private readonly hasVoltage: boolean;
  private last: EnergyReadings = { powerW: null, energyKwh: null, voltageV: null };
  private lastEnergyUnit: string | undefined;
  private lastEventAt = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private primaryChar: any;
  private primaryGet: () => number = () => 0;

  /**
   * The on/off tile on `main` that energy characteristics attach to.
   *
   * Resolved against `accessory.services` rather than `getService()` because hap-nodejs
   * matches by UUID and *ignores* the subtype, so on a multi-component accessory
   * `getService(Switch)` can return a sub-component's `Switch-<componentId>` tile.
   * main's service is the one with no subtype. Lightbulb is included because the
   * `['switch','switchLevel'] -> LightService` mapping consumes `switch` on dimmable
   * metering plugs (Zooz ZEN30, Inovelli), which would otherwise be silently skipped.
   */
  public static findHost(accessory: PlatformAccessory, platform: IKHomeBridgeHomebridgePlatform): Service | undefined {
    const hostUuids = [platform.Service.Outlet.UUID, platform.Service.Switch.UUID, platform.Service.Lightbulb.UUID];
    return accessory.services.find(s => s.subtype === undefined && hostUuids.includes(s.UUID));
  }

  public static hasMeteringCapability(capabilities: string[]): boolean {
    return EnergyService.METERING_CAPABILITIES.some(c => capabilities.includes(c));
  }

  /**
   * Whether energy monitoring applies to this component at all.
   *
   * Shared by MultiServiceAccessory.addComponent (which decides whether to build the
   * service) and SwitchService (which decides whether to republish the tile as an
   * Outlet), so the two can never disagree about a device. TVs and ACs are excluded:
   * they report power too, but have no plain on/off host, so the characteristics would
   * land on the wrong tile (an AC mode switch, a TV volume slider).
   */
  public static isEligible(platform: IKHomeBridgeHomebridgePlatform, multiServiceAccessory: MultiServiceAccessory,
    componentId: string, capabilities: string[]): boolean {
    return platform.config.ExposeEnergyMonitoring === true
      && componentId === 'main'
      && capabilities.includes('switch')
      && !multiServiceAccessory.isTelevisionDevice()
      && !multiServiceAccessory.mainHasCapability('airConditionerMode');
  }

  /**
   * Strip Eve characteristics off cached services when the feature is turned back off.
   * Homebridge persists added characteristics in cachedAccessories, so without this the
   * restored tile keeps advertising CurrentConsumption/TotalConsumption/Voltage with no
   * handler and no updater behind them - frozen at their last value forever.
   */
  public static pruneCachedCharacteristics(accessory: PlatformAccessory): boolean {
    const uuids: string[] = Object.values(EVE_UUID);
    let removed = false;
    accessory.services.forEach(service => {
      service.characteristics
        .filter(c => uuids.includes(c.UUID))
        .forEach(c => {
          service.removeCharacteristic(c);
          removed = true;
        });
    });
    return removed;
  }

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string,
    capabilities: string[], multiServiceAccessory: MultiServiceAccessory, name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.eve = makeEveCharacteristics(platform.api);
    this.hasPower = capabilities.includes('powerMeter') || capabilities.includes('powerConsumptionReport');
    this.hasEnergy = capabilities.includes('energyMeter') || capabilities.includes('powerConsumptionReport');
    this.hasVoltage = capabilities.includes('voltageMeasurement');

    // Attach to the device's existing on/off tile. addComponent only constructs this
    // service when a host exists, so the fallback below is purely defensive.
    const host = EnergyService.findHost(accessory, platform);
    if (host) {
      this.service = host;
    } else {
      this.setServiceType(platform.Service.Outlet);
    }

    // Expose only the characteristics the device actually reports. The first one added
    // becomes the polling "primary" (its value is returned to startPollingState).
    if (this.hasPower) {
      this.addChar(this.eve.CurrentConsumption).onGet(() => this.readChar(() => this.last.powerW, MAX_W));
      this.setPrimary(this.eve.CurrentConsumption, () => this.eveVal(this.last.powerW, MAX_W));
    }
    if (this.hasEnergy) {
      this.addChar(this.eve.TotalConsumption).onGet(() => this.readChar(() => this.last.energyKwh, MAX_KWH));
      this.setPrimary(this.eve.TotalConsumption, () => this.eveVal(this.last.energyKwh, MAX_KWH));
    }
    if (this.hasVoltage) {
      this.addChar(this.eve.Voltage).onGet(() => this.readChar(() => this.last.voltageV, MAX_V));
      this.setPrimary(this.eve.Voltage, () => this.eveVal(this.last.voltageV, MAX_V));
    }

    // Seed from any status already available. Note this is normally a no-op: addComponent
    // builds services before the first status fetch, so component.status is still {}. The
    // energyMeter unit is therefore resolved lazily per event (see energyUnit()) rather
    // than captured here.
    this.refreshFromStatus();

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

  // A HomeKit read refreshes status like every other service, so the value can still be
  // recovered when polling is disabled (PollEnergySeconds: 0) and no webhook is wired up.
  private async readChar(pick: () => number | null, max: number): Promise<CharacteristicValue> {
    if (await this.getStatus()) {
      this.refreshFromStatus();
    }
    return this.eveVal(pick(), max);
  }

  private async pollReadings(): Promise<CharacteristicValue> {
    const ok = await this.getStatus();
    if (ok) {
      this.refreshFromStatus();
      this.pushAll();
    }
    return this.primaryGet();
  }

  /**
   * Merge the latest status snapshot into the cached readings.
   *
   * Deliberately not a wholesale replace. getStatus() returns the *cached* status
   * immediately and refreshes in the background, so the snapshot read here can be older
   * than a webhook event already applied. A field is only taken when the snapshot
   * actually carries it, and a stale snapshot never overwrites a value an event set.
   */
  private refreshFromStatus(): void {
    const fresh = this.readFrom(this.deviceStatus.status);
    const stale = this.multiServiceAccessory.statusTimestamp() <= this.lastEventAt;
    const merge = (next: number | null, prev: number | null): number | null =>
      (next === null || (stale && prev !== null)) ? prev : next;

    this.last = {
      powerW: merge(fresh.powerW, this.last.powerW),
      energyKwh: merge(fresh.energyKwh, this.last.energyKwh),
      voltageV: merge(fresh.voltageV, this.last.voltageV),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readFrom(s: any): EnergyReadings {
    const pcr = s?.powerConsumptionReport?.powerConsumption?.value;
    const rawPower = pcr?.power ?? s?.powerMeter?.power?.value;

    let energyKwh: number | null = null;
    const em = s?.energyMeter?.energy;
    if (typeof em?.value === 'number') {
      energyKwh = this.toKwh(em.value, this.energyUnit());
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

  /**
   * The energyMeter unit, resolved from the latest status read.
   *
   * Only /status carries the unit - webhook events never do. It is resolved lazily (and
   * remembered) rather than seeded in the constructor, because services are built before
   * the first status fetch. Without this, a device reporting Wh would have every event
   * before the first poll converted as kWh, i.e. 1000x too large - and permanently so
   * when PollEnergySeconds is 0.
   */
  private energyUnit(): string | undefined {
    const unit = this.deviceStatus.status?.energyMeter?.energy?.unit;
    if (typeof unit === 'string') {
      this.lastEnergyUnit = unit;
    }
    return this.lastEnergyUnit;
  }

  private toKwh(value: number, unit: string | undefined): number {
    return unit === 'Wh' ? value / 1000 : unit === 'mWh' ? value / 1_000_000 : value; // default kWh
  }

  // Push every exposed characteristic from cache.
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
            next.energyKwh = value.energy / 1000; // Wh -> kWh
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
          next.energyKwh = this.toKwh(value, this.energyUnit()); // events carry no unit
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
    this.lastEventAt = Date.now();
    this.log.debug(`Energy event for ${this.name}: ${event.capability} -> ${this.last.powerW}W`);
    this.pushAll();
  }
}
