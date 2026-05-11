# Supported Devices and Capabilities

This page lists every SmartThings capability the plugin recognizes and the HomeKit service it maps to. If your device exposes one or more of these capabilities, the plugin will create a matching HomeKit accessory automatically.

> **Tip**: To see what capabilities your devices expose, run `smartthings devices` in the SmartThings CLI, or check the device details in the SmartThings developer workspace.

---

## How device discovery works

The plugin examines each SmartThings device's components and capabilities, then:

1. Detects **special device types** first (Samsung TVs, Samsung Family Hub fridges if enabled).
2. Matches **combinations of capabilities** (combo map) to compound services like Thermostats, Air Conditioners, Air Purifiers, Washers, Dryers, Dishwashers, Security Systems, etc.
3. Maps any **remaining single capabilities** to individual services (Lock, Switch, Motion, Contact, etc.).

This ordering means a thermostat (which has `temperatureMeasurement` plus `thermostatMode` plus setpoints) is exposed as a single Thermostat accessory rather than a separate temperature sensor and switch.

---

## Single-capability mappings

These capabilities are mapped one-to-one to a HomeKit service. Order matters — secondary capabilities like `battery` and `contactSensor` are handled last so a primary service (e.g. a lock) gets first claim.

| SmartThings capability | HomeKit service |
|---|---|
| `doorControl` | Garage Door Opener |
| `lock` | Lock Mechanism |
| `switch` | Switch |
| `windowShadeLevel` | Window Covering |
| `windowShade` | Window Covering |
| `motionSensor` | Motion Sensor |
| `waterSensor` | Leak Sensor |
| `smokeDetector` | Smoke Sensor |
| `carbonMonoxideDetector` | Carbon Monoxide Sensor |
| `presenceSensor` | Occupancy Sensor |
| `temperatureMeasurement` | Temperature Sensor *(routed to a fridge-aware variant when `ExposeMultiZoneRefrigerator` is on and the device is a Samsung Family Hub fridge)* |
| `relativeHumidityMeasurement` | Humidity Sensor |
| `illuminanceMeasurement` | Light Sensor |
| `contactSensor` | Contact Sensor |
| `button` | Stateless Programmable Switch |
| `battery` | Battery Service *(companion characteristic added to whatever primary service the device has)* |
| `valve` | Valve |
| `samsungce.airConditionerLighting` | Switch *(only created when `ExposeACDisplayLight` is enabled)* |

---

## Combo-capability mappings

These rules match a **set** of capabilities to a single compound service. The plugin tries them longest-first so a more-specific match wins.

| Required capabilities | Optional capabilities | HomeKit service |
|---|---|---|
| `switch`, `airConditionerMode`, `airConditionerFanMode`, `thermostatCoolingSetpoint`, `temperatureMeasurement` | `fanOscillationMode`, `relativeHumidityMeasurement`, `custom.airConditionerOptionalMode` | Air Conditioner *(Heater Cooler)* |
| `switch`, `airConditionerFanMode` | `custom.filterState`, `airQualitySensor`, `dustSensor`, `veryFineDustSensor`, `odorSensor`, `relativeHumidityMeasurement` | Air Purifier |
| `switch`, `fanSpeed`, `switchLevel` | — | Fan + Light combo |
| `switch`, `fanSpeed` | — | Fan |
| `switch`, `switchLevel` | — | Light (dimmable) |
| `switch`, `colorControl` | — | Light (color) |
| `switch`, `colorTemperature` | — | Light (color temperature) |
| `switch`, `valve` | — | Valve |
| `temperatureMeasurement`, `thermostatMode`, `thermostatHeatingSetpoint`, `thermostatCoolingSetpoint` | — | Thermostat |
| `temperatureMeasurement`, `thermostatHeatingSetpoint` | — | Thermostat *(heat-only)* |
| `temperatureMeasurement`, `thermostatMode`, `temperatureSetpoint` | `switch` | Thermostat *(single setpoint, e.g. Koolnova)* |
| `windowShade`, `windowShadeLevel` | — | Window Covering |
| `windowShade`, `switchLevel` | — | Window Covering |
| `washerOperatingState` | `washerMode`, `remoteControlStatus` | Washer *(Valve with Active/InUse and remaining duration)* |
| `dryerOperatingState` | `dryerMode`, `remoteControlStatus` | Dryer *(Valve with Active/InUse and remaining duration)* |
| `dishwasherOperatingState` | `dishwasherMode`, `remoteControlStatus` | Dishwasher *(Valve with Active/InUse and remaining duration)* |
| `securitySystem` | `alarm`, `panicAlarm`, `temperatureAlarm` | Security System |

---

## Television capabilities

Samsung TVs are detected by the presence of `samsungvd.deviceCategory`, `samsungvd.mediaInputSource`, `audioVolume`/`audioMute`, or `tvChannel`. When `enableTelevisionService` is on (default), these capabilities are bundled into a single Television accessory:

| Capability | Purpose |
|---|---|
| `switch` | Power on/off |
| `samsungvd.deviceCategory` | TV detection marker |
| `samsungvd.mediaInputSource` | Input source picker (HDMI 1, HDMI 2, etc.) |
| `custom.launchapp` | App launcher (Netflix, YouTube, etc. — see `tvApps` in [Configuration Reference](https://github.com/aziz66/homebridge-smartthings/wiki/Configuration-Reference)) |
| `audioVolume` | Volume control (also exposed as a separate slider when `registerVolumeSlider` is on) |
| `audioMute` | Mute |
| `tvChannel` | Channel control |
| `mediaPlayback` | Play/pause/stop |
| `custom.picturemode` | Picture mode selector |
| `custom.soundmode` | Sound mode selector |

Samsung **Frame TVs** additionally support local WebSocket control for true power off and Art Mode toggling — see [Samsung Frame TV](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV).

---

## Special device handling

| Device type | What's special |
|---|---|
| **Samsung Frame TV** | Detected via the `artSupported` flag. Adds local WebSocket support for true power off and an Art Mode switch when configured in `frameTvDevices`. |
| **Samsung Family Hub Refrigerator** | When `ExposeMultiZoneRefrigerator` is on and the device declares `samsungce.driverState`, the plugin parses Samsung's OCF blob to extract per-compartment temperatures (Freezer, FlexZone, CVRoom). Compartments disabled in the SmartThings app are pruned automatically. |
| **Samsung Washers / Dryers / Dishwashers** | Exposed as a Valve accessory with Active/InUse and remaining-duration characteristics. Optional Contact Sensor for HomeKit Activity Notifications when a cycle ends (toggle via `ExposeContactSensorFor*`). The auto-generated Switch tile can be suppressed via `removeLegacySwitchForLaundry`. |
| **SmartThings Security Panel** | Exposed as a Security System accessory. Live alarm state reported via `alarm`, `panicAlarm`, and `temperatureAlarm`. |

---

## My device isn't listed — does that mean it won't work?

Not necessarily. Many devices use one or more of the capabilities above and will be picked up automatically. To check:

1. Run `smartthings devices` and find your device.
2. Look at its `capabilities` list.
3. If any capability matches the tables above, the plugin will create the corresponding HomeKit accessory.

If your device exposes a capability that isn't in this list and you'd like support for it, please [open an issue](https://github.com/aziz66/homebridge-smartthings/issues) describing the device and its capabilities (the SmartThings CLI output is helpful).
