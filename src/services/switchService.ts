import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { EnergyService } from './energyService';

export class SwitchService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities:string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    // Opt-in: publish energy-reporting switches as an Outlet so the Eve app renders
    // the power/energy UI (its energy view conventionally expects an Outlet service).
    // This is a breaking presentation change for existing tiles, hence double-gated
    // (it only makes sense alongside ExposeEnergyMonitoring, which adds the Eve data).
    // The eligibility test is shared with MultiServiceAccessory.addComponent so the two
    // stay in lockstep: without it a metering TV (which reports powerConsumptionReport and
    // keeps a legacy Switch unless removeLegacySwitchForTV is set) would have its tile
    // converted to an Outlet while EnergyService skips it, leaving the breaking
    // presentation change with none of the benefit.
    const exposeAsOutlet = platform.config.ExposeEnergyAsOutlet === true
      && EnergyService.isEligible(platform, multiServiceAccessory, componentId, capabilities)
      && EnergyService.hasMeteringCapability(capabilities);
    // Prune the opposite cached service so flipping the flag doesn't leave a ghost tile
    // alongside the new one (setServiceType only ever adds, never removes).
    const stale = this.findOwnService(exposeAsOutlet ? platform.Service.Switch : platform.Service.Outlet);
    if (stale) {
      accessory.removeService(stale);
    }
    this.setServiceType(exposeAsOutlet ? platform.Service.Outlet : platform.Service.Switch);
    // Set the event handlers
    this.log.debug(`Adding SwitchService to ${this.name}${exposeAsOutlet ? ' (as Outlet for energy)' : ''}`);
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getSwitchState.bind(this))
      .onSet(this.setSwitchState.bind(this));

    let pollSwitchesAndLightsSeconds = 10; // default to 10 seconds
    if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSwitchesAndLightsSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }

    if (pollSwitchesAndLightsSeconds > 0) {
      multiServiceAccessory.startPollingState(pollSwitchesAndLightsSeconds, this.getSwitchState.bind(this), this.service,
        platform.Characteristic.On);
    }
  }

  // Set the target state of the lock
  async setSwitchState(value: CharacteristicValue) {
    this.log.debug('Received setSwitchState(' + value + ') event for ' + this.name);

    if (!(await this.multiServiceAccessory.sendCommand(this.componentId, 'switch', value ? 'on' : 'off'))) {
      this.log.error(`Command failed for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  // Get the current state of the lock
  async getSwitchState(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getSwitchState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          let switchState;
          try {
            switchState = this.deviceStatus.status?.switch?.switch?.value;
          } catch(error) {
            this.log.error(`Missing switch status from ${this.name}`);
          }
          this.log.debug(`Switch value from ${this.name}: ${switchState}`);
          resolve(switchState === 'on');
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      }).catch(() => reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
    });
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'switch') {
      this.log.debug(`Event updating switch capability for ${this.name} to ${event.value}`);
      this.service.updateCharacteristic(this.platform.Characteristic.On, event.value === 'on');
    }
  }
}