# Changelog
All notable changes to this project will be documented in this file.

## [1.0.61-beta.3] - Thermostat & Online-Recovery Fixes, TV Serialization Fix, External-by-Default Restoration

> Bundled fixes spanning two community-reported issues — #33 (thermostat + online-flag work from @maxbaillargeon on Stelpro Zigbee hardware) and #31 (TV cache-serialization fix from @apexad) — plus a decision to restore external-by-default TV publishing now that the underlying serialization bug is fixed (reverting the beta.2 default-flip).

### Fixed
- **Cloud `/health` no longer marks devices permanently offline** (#33): `MultiServiceAccessory.checkDeviceHealth()` previously set `this.online = false` whenever cloud `/health` returned anything other than `ONLINE` (or threw). For locally-executing SmartThings Edge drivers (e.g. Stelpro Edge on a v3 hub), cloud `/health` frequently reports stale OFFLINE even when the device is fully reachable via `/status`, which then short-circuited every read in `baseService.getStatus()` and made HomeKit display literal `0` for temperature, `OFF` for mode, etc. `/health` is now treated as advisory log-only; the existing `failureCount`-based offline detection in `refreshStatus()` and `startPollingState()` remains the source of truth for real outages.
- **Heating-only thermostats now retain `thermostatMode` and `thermostatOperatingState`** (#33): The `[temperatureMeasurement, thermostatHeatingSetpoint]` combo at `multiServiceAccessory.ts` had no optional capabilities, so devices like the Stelpro ST218 (heat + mode + temp, no cooling setpoint) matched the heater combo and had `thermostatMode` stripped from the service's registered capability list. `thermostatService.ts` then unconditionally returned OFF at three call sites (`getTargetHeatingCoolingState`, `setTargetHeatingCoolingState`, `getCurrentHeatingCoolingState`) and silently no-op'd mode-change commands. Heater combo now declares `thermostatMode` and `thermostatOperatingState` as optional. Combo sort order (longest-required-first) preserves existing behavior for full Samsung thermostats (mode + heat + cool + temp combo still wins when all four are present).
- **`CurrentHeatingCoolingState` now consults `thermostatOperatingState` when present** (#33): HAP's `CurrentHeatingCoolingState` is "what the device is doing right now", not "what mode it is set to". Devices exposing `thermostatOperatingState` (most Zigbee/Z-Wave thermostats, including Stelpro) now report `HEAT`/`COOL` only when actively heating/cooling, `OFF` when idle or at setpoint. Devices without the capability fall back to mode-based mapping unchanged.
- **`Target Temperature` "exceeded minimum of 10" warning on frost-protection setpoints** (#33): `thermostatService.ts` never called `setProps()` on the `TargetTemperature` characteristic, so HomeKit used its default `minValue: 10`. Stelpro and many EU/Canada baseboard/in-floor thermostats use 5 °C frost protection, which tripped the warning every poll. Now sets `{ minValue: 5 }`. `maxValue` (38 °C) and `minStep` (0.1 °C) keep HAP defaults so Samsung thermostats retain their fine slider precision and high-setpoint commercial devices aren't clamped.
- **`Cannot serialize accessory 'Samsung TV' - missing associated platform`** (#31 follow-up from @apexad): Two `updatePlatformAccessories([this.accessory])` calls in `src/services/televisionService.ts` (in `registerInputSourceCapability` and `checkAndUpdateInputSources`) ran on externally-published TVs *after* they were already published. Externally-published accessories never have `_associatedPlatform` set (it's only set by `registerPlatformAccessories` — confirmed in Homebridge core `api.js:131-148` and `platformAccessory.js:14`), so the bridge's `handleUpdatePlatformAccessories` (`bridgeService.js:297-306`) merged the external TV into its `cachedPlatformAccessories` list and the next `saveCachedPlatformAccessoriesOnDisk` (`bridgeService.js:264-276`) threw on serialization. The throw is caught and printed as the user-visible error, but the entire cache save is aborted — so every other plugin sharing the bridge stops persisting accessories until the next restart. Removed both calls; instead, input-source registration now runs synchronously inside the accessory-construction path (via async `MultiServiceAccessory.addComponent` + `await` in `platform.ts:createAccessoryObject`), so all input services are present on the accessory before it's registered/published — no post-hoc cache update is needed.
- **Race condition in TV input-source registration on slow networks**: `registerInputSourceCapability` was previously fired via `setTimeout(..., 100)` so it could run after the constructor returned. On slow networks, the SmartThings `/status` fetch inside `setupInputSources` could complete after the accessory was already published with no input services — leaving the TV with no input picker until restart. The synchronous-await refactor above fixes this side-effect too.

### Note
- **Bridged TV input-source cache lag** (`publishTVsAsExternal: false` only): with both `updatePlatformAccessories([this.accessory])` calls removed from `televisionService.ts`, newly-discovered SmartThings TV inputs are no longer immediately persisted to Homebridge's cache file for bridged TVs. Inputs work normally at runtime (HAP exposes services as they're added, and the cache rebuilds on next startup via `setupInputSources` with `getService(...) || addService(...)` dedup at `televisionService.ts:271`). The only user-visible effect is a one-restart delay before a freshly-detected input shows up after a power cycle. External TVs (`publishTVsAsExternal: true`, the default) don't use the bridge cache and are unaffected.

### Changed
- **`publishTVsAsExternal` now defaults to `true`** (#31, #37): with the serialization bug fixed, external publishing is safe again, so the v1.0.59 icon-by-default behavior is restored (this reverts the beta.2 default-flip to `false`). Users who prefer bridged TVs (simpler pairing — Apple Home → + → Add Accessory through the standard flow) can opt out by setting `publishTVsAsExternal: false` in plugin config. **Migration impact:** users on `1.0.61-beta.2` who never set the option will silently flip from bridged back to external — their existing bridged TV tile becomes a "No Response" orphan in Apple Home (long-press → Accessory Settings → Remove Accessory) and the new external TV must be paired via Apple Home → + → Add Accessory → "More options…" → Nearby Accessories → enter bridge or child-bridge PIN. Users who explicitly set `publishTVsAsExternal: false` are unaffected.

### Credit
- **Thermostat & online-recovery diagnosis driven by @maxbaillargeon's debug-mode logs and `/status` payload analysis** on issue #33. Three Stelpro hypotheses pointed straight at the bugs and saved a guessing round.
- **TV serialization diagnosis and fix patch contributed by @apexad** on issue #31 (commit `86f3709` on `apexad:fix-tv-serialization-error-5218849286044784677`).

## [1.0.61-beta.2] - Multi-Component Refrigerator Fixes, Sub-Component Command Routing, and TV Publishing Opt-In

> Follow-up to 1.0.61-beta.0/beta.1 verification by @grecine on Samsung RF29DB9600QLA. Fixes two real bugs surfaced during testing, and reverts the v1.0.59 forced TV-publishing-model change to opt-in based on user feedback (issues #31, #37).

### Changed
- **TV publishing model is now opt-in via `publishTVsAsExternal` (default `false`)** (#31, #37): v1.0.59 unconditionally migrated Samsung TVs from bridged accessories to externally-published accessories so HomeKit could render the proper TV icon and Control Center remote. The migration was technically correct — the TV-specific UI in HomeKit *requires* the accessory to advertise `ci=TELEVISION` on its own Bonjour record, which bridged children cannot do — but the user-visible cost was higher than the icon win: every TV had to be re-paired through the non-obvious "More options → Nearby Accessories" flow (#37), and a stricter `_associatedPlatform` serialization check in newer Homebridge versions (≥ 1.10) surfaced an orphaned-cache error on the bridged-to-external transition (#31 follow-up from @apexad). This release reverts the default to **bridged TVs** (matching pre-1.0.59 behavior — generic icon, no extra pairing step, no cache friction). Users who prefer the proper TV icon and Control Center remote can opt in with `publishTVsAsExternal: true` in plugin config; the external-publishing path is unchanged when enabled. **Migration impact:** users on 1.0.59-1.0.61 who upgrade with the default leave their existing externally-paired TV tiles as HomeKit orphans (No Response) and get a new bridged tile, and need to remove the orphans manually from Apple Home; users who set `publishTVsAsExternal: true` keep their existing external pairings intact (same UUID → same advertise address → same HomeKit identity).

### Fixed
- **Disabled-compartment pruning never actually skipped anything** (#35 follow-up): `extractDisabledComponents` and `readDriverStateValue` (`src/util/samsungRefrigerator.ts`) expected `mainStatus.custom.disabledComponents.disabledComponents.value` and `mainStatus.samsungce.driverState.driverState.value` — but the SmartThings `/devices/{id}/status` endpoint actually returns capability keys flat at the top of `mainStatus` (e.g. `mainStatus["custom.disabledComponents"].disabledComponents.value`). Result: `extractDisabledComponents()` always returned `[]`, so every compartment the user had disabled in the SmartThings app still showed up as a HomeKit tile (8 ghost tiles on @grecine's RF29: icemaker-03, pantry-01, pantry-02, specialzone-01, scale-10, scale-11, cvroom, onedoor). The same shape mismatch silently broke OCF per-zone temperature extraction. Both functions now read the flat capability key first and fall back to the legacy nested shape.
- **Duplicate "Refrigerator" tile from `main`/`cooler` mirroring**: Samsung Family Hub fridges expose `temperatureMeasurement` on both the `main` component and the `cooler` component, mirroring the same value. With `ExposeMultiZoneRefrigerator` enabled, both produced HomeKit tiles. The plugin now strips `temperatureMeasurement` from `cooler` at discovery (`src/platform.ts`) when `main` already has it, leaving a single canonical Fridge tile.
- **Commands to non-`main` components returned 422 from SmartThings**: `MultiServiceAccessory.sendCommand` and the `Command` class did not accept a `componentId`, so the SmartThings API silently routed every command to `main`. For multi-component devices, this meant toggling a sub-component (e.g. an Ice Maker switch on a refrigerator) tried to switch `main` — which has no switch capability — and was correctly rejected as `422 Unprocessable Entity`. `Command` now accepts a `componentId` and injects the `component` field into the API payload when it is anything other than `main`; `MultiServiceAccessory.sendCommand` accepts `componentId` as its first argument; every service in `src/services/*` now passes `this.componentId` when building commands. Fixes the Ice Maker switch on Samsung Family Hub refrigerators and pre-emptively fixes the same class of bug on any future multi-component device (multi-zone ACs, multi-input AVRs, etc.).

### Credit
- **Refrigerator fixes contributed by @grecine** as follow-ups to PR #35, verified end-to-end on a Samsung RF29DB9600QLA. Thanks again for the detailed testing and for sending the OCF status payloads that pinpointed the parser shape mismatch.
- **TV publishing opt-in driven by feedback from @apexad and @SSutherland94** on issues #31 and #37.

## [1.0.61-beta.1] - OAuth Wizard Diagnostic Errors

### Fixed
- **OAuth wizard now surfaces the real token-exchange error** (#36): Step 4 of the wizard previously showed a generic "Could not request authorization token. Please try again." toast for every failure, regardless of root cause. The actual OAuth2 error returned by SmartThings (`invalid_grant`, `redirect_uri_mismatch`, `invalid_client`, `invalid_scope`, `unauthorized_client`, etc.) was discarded by the UI server and never reached the user or the Homebridge log, making remote diagnosis impossible. The wizard now extracts the OAuth2 error code and `error_description` from `simple-oauth2`'s wrapped Boom error (`err.data.payload`/`err.output.payload`), shows them in the toast, and logs the full provider response to the Homebridge log under `[homebridge-smartthings-oauth]`. Also adds an explicit error if `/authToken` is invoked before `/authCode` has initialized the OAuth client (e.g. after a Homebridge restart between wizard steps).

## [1.0.61-beta.0] - Multi-Component Samsung Refrigerator Support (Beta)

> Pre-release for verification by @grecine and other Samsung Family Hub owners. Will graduate to 1.0.61 stable once confirmed against real hardware.

### Added
- **`ExposeMultiZoneRefrigerator` config option** (#35): New boolean toggle (default `false`) for Samsung Family Hub refrigerators that expose multiple compartments (`main`, `freezer`, `cvroom`, `onedoor`, `flexZone`, etc.). Samsung returns `null` on the standard `temperatureMeasurement` capability for sub-components — the real per-zone readings live in an OCF blob at `main.status.samsungce.driverState`. When enabled, the plugin parses that blob so each compartment reports its own temperature in Apple Home, with friendly labels (e.g. "Freezer", "FlexZone"). Compartments the user has disabled in the SmartThings app (`custom.disabledComponents`) are pruned at discovery so no ghost tiles appear in HomeKit. Standard single-zone refrigerators and non-fridge devices are completely unaffected — the OCF code path is gated behind both the config flag and a `samsungce.driverState` capability probe on the device's main component.

### Credit
- **Feature contributed by @grecine in PR #35** (tested against Samsung RF29DB9600QLA). This release re-implements the same feature against current code in a dedicated `RefrigeratorTemperatureService` + `samsungRefrigerator` util module, drops behavior changes from the original PR that masked failures on life-safety sensors, and prunes disabled compartments at discovery rather than at every characteristic read. Huge thanks to @grecine for the OCF reverse-engineering and the test fixtures.

### Note
- **Read-only for now**: Refrigerator setpoint control is not yet exposed; this release covers per-compartment temperature reporting and disabled-compartment pruning. Setpoint commands can be added in a follow-up if requested.
- **Tested on US-region firmware** (Samsung RF29DB9600QLA). Samsung's OCF driver state reports temperatures in Fahrenheit on the firmware we've verified; metric-region Family Hub devices may report Celsius and would currently display incorrect values — please open an issue with a sample OCF blob if you see wrong readings and we'll add the unit-handling.

## [1.0.60] - Optional Suppression of Legacy Switch on Laundry Devices

### Added
- **`removeLegacySwitchForLaundry` config option** (#34): New boolean toggle (default `false`) that suppresses the auto-generated Switch tile on washers, dryers, and dishwashers when these devices expose both an operating-state capability and a `switch` capability in SmartThings. The main Valve tile (Active/InUse + remaining duration) and any optional Contact Sensor for activity notifications are unaffected — only the redundant Switch tile is removed. Mirrors the existing `removeLegacySwitchForTV` pattern. Existing users see no change unless they enable the toggle.

## [1.0.59] - Security Panel Support + Correct TV Icon

### Added
- **Security System service** (#32): Devices with the SmartThings `securitySystem` capability are now exposed as Security System tiles in Apple Home, with arm/disarm controls (Stay, Away, Night, Off) and live current-state reporting. The plugin reads `supportedSecuritySystemCommands` to constrain which arm modes appear in HomeKit, so panels that don't support a given mode (e.g. no Night arm) won't show it. Webhook subscriptions provide real-time updates; polling is the fallback (configurable via the new `PollSecuritySystemsSeconds` setting, default 15s).
- **Alarm-trigger reporting**: When a device also exposes the `alarm`, `panicAlarm`, or `temperatureAlarm` capabilities, an active siren, panic button press, or extreme temperature alarm flips the HomeKit `SecuritySystemCurrentState` to "Alarm Triggered" and sets `SecuritySystemAlarmType`. The state clears once all active alarm sources clear.
- **`PollSecuritySystemsSeconds` config option**: Dedicated polling interval for security panels (default 15s). Configured separately from generic sensor polling because panels typically rate-limit aggressive polling.

### Fixed
- **Generic icon for Samsung TVs in Apple Home** (#31): TV accessories were registered as bridged accessories, so HomeKit ignored their `Categories.TELEVISION` setting and rendered them with the generic Home placeholder icon (orange house). Even though the Television service worked (inputs, power, remote), HomeKit only advertises a per-accessory category (`ci=TELEVISION` Bonjour TXT) for accessories published as standalone, which is why every working Homebridge TV plugin uses external publishing. TVs are now published via `publishExternalAccessories`, giving them their own HAP server, their own pairing, and the proper TV tile in Home with Control Center remote support.

### Note
- **Existing TV users must re-add their TV in the Home app** after upgrading. The plugin will automatically unregister the old bridged TV tile on first start. To add the new external TV: open the **Apple Home** app → tap **+** → **Add Accessory** → tap **"More options…"** → the TV appears in the Nearby Accessories list → tap it → when prompted, enter your **bridge PIN** (or **child-bridge PIN** if you run this plugin in a child bridge). The Homebridge UI does not display a per-accessory QR code for external accessories — pairing is initiated from the Home app, not from Homebridge UI. Inputs, volume slider (if enabled), and Frame TV WebSocket settings continue to work as before — input source names are re-fetched from SmartThings on first connect, so the only thing that resets is the HomeKit pairing itself.
- **Disabling `enableTelevisionService` after upgrading**: If you later set `enableTelevisionService: false` to revert a TV to a bridged switch, the externally-published TV tile will remain in Apple Home as an orphan. Remove it manually from the Home app (long-press the tile → Accessory Settings → Remove Accessory) before the bridged switch will appear cleanly.
- **Standalone siren/alarm devices** (devices that expose the `alarm` capability but not `securitySystem`) are not yet exposed as HomeKit accessories. If you have such a device and want it controllable from Home, please open an issue and we'll add a follow-up service.
- **`bypassAll` is hardcoded to `false`** for `armStay`/`armAway` commands. If a sensor is open when you arm, SmartThings will report a not-ready state rather than silently bypassing the zone. Open an issue if you want this configurable.

## [1.0.58] - Dryer & Dishwasher Support with Activity Notifications

### Added
- **Dryer Service** (#29): Devices with the `dryerOperatingState` SmartThings capability are now properly detected and exposed as Valve accessories in HomeKit with Active/InUse status and a remaining duration countdown. Active dryer job states: cooling, drying, refreshing, weightSensing, wrinklePrevent, dehumidifying, aiDrying, sanitizing, internalCare.
- **Dishwasher Service** (#29): Devices with the `dishwasherOperatingState` SmartThings capability are now properly detected and exposed as Valve accessories in HomeKit with Active/InUse status and a remaining duration countdown. Active dishwasher job states: airwash, cooling, drying, preDrain, prewash, rinse, spin, wash, wrinklePrevent.
- **Optional Contact Sensor for Dryers and Dishwashers**: New `ExposeContactSensorForDryers` and `ExposeContactSensorForDishwashers` config toggles enable Activity Notifications in Apple Home for dryers and dishwashers, using the same Contact Sensor workaround as the washer.

## [1.0.57] - Washer Activity Notifications via Contact Sensor & onGet Performance Fix

### Added
- **Optional Contact Sensor for Washer Activity Notifications** (#29): HomeKit's Valve service (used by the washer) does not support Activity Notifications — only locks and sensors do. When the new `ExposeContactSensorForWashers` toggle is enabled in plugin settings, a Contact Sensor is added as a secondary service alongside the existing Valve on washer accessories. The sensor opens when a wash cycle is active (wash, rinse, spin, weightSensing, wrinklePrevent, drying) and closes when the cycle finishes or the machine stops. This allows users to enable Activity Notifications in Apple Home and receive push notifications when their washer starts and finishes a cycle.

### Fixed
- **"Slow to respond" Homebridge warning on characteristic reads**: All `onGet` handlers (e.g., switch state, lock state, sensor values) were blocking on a synchronous SmartThings API call whenever the 5-second status cache expired, causing Homebridge to flag the plugin as slow. Handlers now return cached device state immediately and trigger a background refresh when stale. Polling and webhook events continue to push fresh values via `updateCharacteristic()` as before. Only the very first read at startup blocks on the API call to populate initial state.

## [1.0.56] - 401 Token Refresh Race Fix & Washer Poll Rate

### Fixed
- **Persistent 401 errors when multiple devices poll simultaneously** (#28): When the access token expired, multiple devices polling at the same time each independently attempted to refresh the token. This race condition could corrupt the refresh token state (especially with rotating refresh tokens), causing a permanent 401 loop with no recovery. The 401 interceptor now uses a dedup lock — the first 401 triggers a single token refresh, and all concurrent 401s wait for that result instead of racing.
- **Auth flow log spam on persistent token failure**: When tokens are permanently invalid (e.g. expired refresh token), `startAuthFlow()` was called on every failed poll cycle, flooding the logs. It is now rate-limited to 3 rapid calls, then once per 10 minutes.
- **Washer/dryer polling too aggressive**: The washer service was using the sensor polling interval (`PollSensorsSeconds`, default 5s) instead of the switch/light interval (`PollSwitchesAndLightsSeconds`, default 10s). Washers and dryers change state infrequently, and the aggressive polling contributed to hitting SmartThings API rate limits.

## [1.0.55] - Air Purifier Double-Beep Fix on Mode Switch

### Fixed
- **Air Purifier double-beep when switching Auto↔Manual** (#24): When switching between Auto and Manual modes, HomeKit sends `setActive(1)` alongside mode/speed changes even when the device is already on. The fan mode debounce correctly collapses mode and speed into one command, but `setActive(1)` was sent immediately as a redundant `switch on` — causing the Samsung purifier to beep once for the no-op switch command and once for the actual mode change. The plugin now checks the cached device status before sending `switch on`; if the device is already on, the redundant command is skipped. Turning off always sends immediately, and turning on from off works normally.

## [1.0.54] - Fix Thermostat Custom Mode Commands (HTTP 422)

### Fixed
- **Custom thermostat modes fail with HTTP 422** (#25): Custom modes like `radiatingfloor` configured via `thermostatModeOverrides` were sent as direct command names (e.g. `{"command":"radiatingfloor"}`), which SmartThings rejects. Now uses the canonical `setThermostatMode` command with the mode as an argument (`{"command":"setThermostatMode","arguments":["radiatingfloor"]}`), which works for both standard and custom modes.

## [1.0.53] - Configurable Thermostat Mode Mapping

### Added
- **Thermostat Mode Overrides** (#25): New `thermostatModeOverrides` config option to control which SmartThings thermostatMode is sent when HomeKit requests HEAT or COOL. This lets users with non-standard HVAC systems (e.g. Koolnova with `radiatingfloor`, `radiatingfloorandhotair`) choose which mode maps to HomeKit HEAT/COOL on a per-device basis. Devices without overrides continue to use the defaults (`heat`/`cool`).
  - Configure per device by name (case-insensitive matching)
  - Available in the Homebridge UI under "Thermostat Mode Overrides"
  - Only affects the SET direction (HomeKit → SmartThings); GET direction already handles custom modes correctly

## [1.0.52] - Generic Thermostat Switch-Based Power State Fix

### Fixed
- **Thermostat showing active when zone is off** (#25): For third-party thermostats (e.g. Koolnova) that expose both `switch` and `thermostatMode`, the plugin now checks `switch` first to determine the real power state. These devices keep `thermostatMode` at its last value (e.g. `heat`) even when the zone is powered off via `switch`. Previously this caused all zones to appear as active/heating in HomeKit regardless of actual state.
- **Atomic switch + mode commands**: Setting thermostat state from HomeKit now bundles `switch` and `thermostatMode` into a single SmartThings API call (matching the AirConditionerService pattern), avoiding race conditions from separate fire-and-forget calls.
- **Real-time temperature events**: Incoming `temperature` webhook events are now correctly handled by ThermostatService. Previously, temperature events would fall through to the thermostatMode handler and incorrectly set the heating/cooling state to HEAT.
- **Real-time switch events**: Incoming `switch: off` webhook events for thermostat devices now immediately update both current and target state to OFF in HomeKit.
- **isOnline() method call**: Fixed `isOnline` being checked as a property (always truthy) instead of called as a method, so the offline guard in `setTargetHeatingCoolingState` now works correctly.

## [1.0.51] - Air Purifier Command Debounce Improvements & Offline Log Spam Fix

### Fixed
- **Air Purifier double/triple beeps (improved)**: v1.0.50 debounce only handled the Manual direction. Switching between Auto and Manual still caused 2 beeps because HomeKit sends `setTargetAirPurifierState` and `setRotationSpeed` near-simultaneously in both directions. All fan mode commands now go through a unified debounce with order-independent priority resolution (Auto > RotationSpeed > Manual default), ensuring only a single `setFanMode` command is sent regardless of callback ordering.
- **Offline device log spam** (#26): When a device is offline (e.g. washer in standby), every HomeKit characteristic query logged `"<device> is offline"` at info level. With multiple services and short poll intervals, this produced 10+ messages per cycle. Changed to debug level and added missing `return` to avoid unnecessary API calls to SmartThings for known-offline devices.

## [1.0.50] - Air Purifier Command Debounce & Sensor Fixes

### Fixed
- **Air Purifier double beeps**: Switching to Manual mode in HomeKit previously sent two SmartThings commands simultaneously (one from the mode selector, one from the rotation speed slider), causing the purifier to beep 2-3 times. Mode and speed commands are now debounced — when switching to Manual, the plugin waits 500ms for a rotation speed update before sending any command, ensuring only a single `setFanMode` is sent.
- **Air quality event overwriting PM2.5-based value**: Real-time `airQualitySensor` webhook events would overwrite the accurate PM2.5-derived air quality with the unreliable SmartThings value (which often returns 1/"Excellent" regardless of actual conditions). The event handler now skips `airQualitySensor` events when `dustSensor` is available, matching the polling logic introduced in v1.0.48.

### Added
- **`veryFineDustSensor` optional capability**: Samsung air purifiers that report `veryFineDustSensor` (PM1.0) now have this capability consumed by the AirPurifierService, preventing it from being left unmatched during service registration.

## [1.0.49] - Generic Thermostat Support (temperatureSetpoint)

### Added
- **Generic thermostat support**: Devices using the `temperatureSetpoint` capability (single unified setpoint) are now recognized as thermostats in HomeKit. Previously these devices appeared as a simple switch + temperature sensor. This supports third-party HVAC systems like Koolnova that integrate with SmartThings using `temperatureSetpoint` instead of the standard `thermostatHeatingSetpoint`/`thermostatCoolingSetpoint` split.
  - View current temperature
  - Set target temperature
  - Thermostat mode control (heat/cool/off)
  - Real-time webhook updates for `temperatureSetpoint` events
- **Custom thermostat mode handling**: Non-standard thermostat modes (e.g. `radiatingfloor`, `radiatingfloorandhotair`) are now mapped to HEAT in HomeKit instead of being treated as OFF. This ensures active heating modes from third-party systems display correctly.

### Note
- Users with affected devices (previously showing as switch) will need to remove the cached accessory from Homebridge and restart to allow it to re-discover as a thermostat. This can be done from the Homebridge UI under Accessories > Remove Single Cached Accessory.

## [1.0.48] - Air Quality Sensor Fix

### Fixed
- **Air Quality always showing "Excellent"**: SmartThings `airQualitySensor.airQuality.value` returns an unreliable value (often 1 regardless of actual air conditions). Air quality is now derived from PM2.5 readings when `dustSensor` capability is available, using WHO-based thresholds: <=15 Excellent, <=35 Good, <=55 Fair, <=75 Inferior, >75 Poor. Falls back to SmartThings 1-5 scale when dustSensor is unavailable.
- **Real-time air quality updates**: Incoming `dustSensor` `fineDustLevel` events now also update the `AirQuality` characteristic based on PM2.5 values, ensuring the air quality level stays accurate between polls.

## [1.0.47] - Samsung Air Purifier Capability Fix

### Fixed
- **Air Purifier capability mismatch**: Samsung air purifiers report `airConditionerFanMode` (not `airPurifierFanMode`) for fan mode control. Updated the combo capability match and all command/status paths to use the correct SmartThings capability name. Previously, the air purifier would incorrectly appear as a plain switch in HomeKit.
- **Fan mode command**: Changed from `setAirPurifierFanMode` to `setFanMode` to match the actual SmartThings API command for the `airConditionerFanMode` capability.
- **Fan mode status path**: Fixed status read from `airConditionerFanMode.airConditionerFanMode.value` to `airConditionerFanMode.fanMode.value`.

## [1.0.46] - Samsung Air Purifier Support

### Added
- **Air Purifier Service**: New `AirPurifierService` for Samsung air purifier devices, mapped to HomeKit's native `Service.AirPurifier`
  - Power on/off via `switch` capability (Active + CurrentAirPurifierState)
  - Fan mode control via `airConditionerFanMode` capability (Auto, Low, Medium, High, Sleep) mapped to TargetAirPurifierState and RotationSpeed
  - Filter life monitoring via `custom.filterState` capability (FilterLifeLevel + FilterChangeIndication at <10%)
- **Linked Air Quality Sensor**: Conditional `Service.AirQualitySensor` linked to the air purifier
  - Air quality index derived from PM2.5 readings (WHO-based thresholds) with fallback to SmartThings `airQualitySensor` value
  - PM2.5 density via `dustSensor` (`fineDustLevel`)
  - PM10 density via `dustSensor` (`dustLevel`)
  - VOC density via `odorSensor` (`odorLevel`)
- **Linked Humidity Sensor**: Conditional `Service.HumiditySensor` linked to the air purifier via `relativeHumidityMeasurement` capability
- **Real-time event handling**: Full `processEvent()` support for all air purifier capabilities via webhooks
- **Polling**: Automatic polling for Active state and RotationSpeed

## [1.0.45] - OAuth Wizard Popup Fix

### Fixed
- **OAuth Wizard popup blocked**: The SmartThings login popup in step 3 of the OAuth wizard was silently blocked by browsers for many users. The `window.open()` call happened after an `await`, which breaks the browser's user-gesture context and triggers popup blockers. The window is now opened synchronously before the async call to preserve the gesture chain.
- **Popup fallback URL field**: Step 3 now always displays a copyable URL field with the authorization link, so users can manually open it if the popup is still blocked by stricter browser settings.

## [1.0.44] - Samsung Frame TV, TV App Launcher & Washer Service

### Added
- **Samsung Frame TV Full Power Off**: Frame TVs now support true power off via a 3.5-second long-press of KEY_POWER sent over local WebSocket. The standard SmartThings `switch.off` command only puts Frame TVs into Art Mode — this bypasses that behavior entirely.
- **Art Mode Switch**: A separate HomeKit switch to toggle Art Mode on and off for each configured Frame TV. Appears as its own tile in the Home app for easy access and automation.
- **Local WebSocket Connection Manager** (`src/local/samsungWebSocket.ts`): Handles secure WebSocket connections to Samsung TVs on port 8002 (remote control) and port 8001 (Art Mode channel). Supports lazy connect-on-demand and automatic idle disconnect after 8 seconds.
- **TV Authorization Token Flow**: First-time connections prompt an "Allow/Deny" popup on the TV. Once accepted, the token is saved automatically and reused for all future connections — no manual pairing code needed.
- **Frame TV Configuration UI**: New "Samsung Frame TV Settings" section in the Homebridge UI to add/remove Frame TV devices with IP address, full power off toggle, and Art Mode toggle.
- **Frame TV Auto-Detection**: The plugin automatically detects Frame TVs by checking the `artSupported` field from SmartThings device status. A helpful log message is shown during startup if a Frame TV is found but not yet configured, guiding users to add the TV's local IP address.
- **`frameTvDevices` config field**: New array in `config.schema.json` for configuring Frame TV devices with `deviceName`, `ip`, `enableFullPowerOff`, `enableArtModeSwitch`, and optional `token` fields.
- **TV App Shortcuts**: Launch Samsung TV apps (Netflix, YouTube, Disney+, etc.) directly from the HomeKit TV input picker. Apps appear as additional input sources (type APPLICATION) alongside HDMI inputs. Select which apps to enable from the "TV App Shortcuts" card in the Homebridge UI. Uses `custom.launchapp` capability — no apps enabled by default.
- **TV App Shortcuts UI**: New "TV App Shortcuts" card in the Homebridge UI with a checkbox list of 18 predefined Samsung TV apps. Only selected apps appear in the HomeKit input picker.
- **`tvApps` config field**: New array in `config.schema.json` for selecting TV app shortcuts by app ID (default: empty).
- **Washer Service**: New service mapping `washerOperatingState` capability to a HomeKit Valve with Active, InUse, and RemainingDuration countdown for Samsung washers.
- **README section**: Added documentation covering Frame TV auto-detection, configuration options, first-time pairing, troubleshooting, and how to recover from an accidental "Deny" on the TV popup.

### Changed
- **TelevisionService**: When a Frame TV is configured, power off is intercepted and routed through the local WebSocket instead of the SmartThings API. Power on continues to use the SmartThings API as normal. On WebSocket failure, falls back to SmartThings API with a warning log.
- **MultiServiceAccessory**: Detects Frame TV devices by matching the SmartThings device name against `frameTvDevices` config entries (case-insensitive). Creates a shared `SamsungWebSocket` instance used by both the TV service and Art Mode switch.
- **Platform**: Registers Art Mode accessories as separate platform accessories after device discovery, with UUIDs derived from `deviceId + '-artmode'` to ensure uniqueness.

### Fixed
- **Art Mode Accessory Registration**: Fixed incorrect `PLUGIN_NAME` (`homebridge-smartthings-ik` instead of `homebridge-smartthings-oauth`) which prevented the Art Mode switch from appearing in HomeKit.
- **Art Mode Accessory Persistence**: Fixed a bug where the Art Mode accessory was unregistered and re-registered on every restart because its derived UUID didn't match any SmartThings device ID. Art Mode accessories are now excluded from the cleanup loop.

### Security
- **Dependency audit**: Fixed all 6 npm audit vulnerabilities (axios, form-data, glob, js-yaml, brace-expansion, diff) — 0 vulnerabilities remaining.

### Dependencies
- Added `ws` (^8.0.0) and `@types/ws` (^8.0.0) for local WebSocket communication with Samsung TVs.

## [1.0.43] - Real-Time Subscription Manager UI
### Added
- **Capability Subscription Selector**: New UI card in Homebridge settings to manually choose which capabilities get real-time SmartThings subscriptions (max 20). Available for users with webhooks configured.
  - Checkbox list of all discovered capabilities sorted by device count
  - Counter badge showing selected / 20 limit
  - "Clear All" and "Auto (by device count)" quick-select buttons
  - "Save & Apply Subscriptions" flushes and recreates subscriptions immediately without restarting the plugin
  - "Refresh List" to reload discovered capabilities
- **`selectedCapabilities` config field**: Optional array in config.schema.json to persist manual capability selections across restarts. Leave empty for automatic prioritization (existing behavior).
- **`available_capabilities.json`**: Plugin now writes discovered capabilities and device counts to Homebridge storage after device discovery, enabling the UI to display them.
- **Server endpoints**: `/capabilities` (read discovered list) and `/resubscribe` (flush + create subscriptions via SmartThings API) added to the UI server.

### Fixed
- **Security (XSS)**: Replaced all `innerHTML` string concatenation in the capability selector with safe `createElement`/`textContent` DOM building
- **Security (Input Validation)**: `/resubscribe` endpoint now validates capability names against the discovered list before sending to SmartThings API
- **Reliability**: `writeAvailableCapabilities` now uses async `fs.promises.writeFile` with atomic temp+rename instead of blocking `writeFileSync`
- **Error Handling**: Added JSON schema validation for `available_capabilities.json` and `smartthings_tokens.json` reads in server endpoints
- **Error Handling**: Plugin now logs a clear warning and falls back to automatic prioritization when all user-selected capabilities are invalid
- **UX**: "Save & Apply" button disables during the request to prevent duplicate flush+create cycles
- **UX**: Improved error messages in capability list loading with actionable guidance

## [1.0.42] - OAuth Wizard UI Fix
### Fixed
- **OAuth Wizard Flashing/Disappearing**: Fixed issue where the OAuth setup wizard would briefly flash and then disappear. This was caused by the `configChanged` event triggering `updateUi()` which would hide the wizard. Added state tracking to prevent the wizard from being closed when intentionally opened.

## [1.0.41] - Documentation Update
### Changed
- Updated CHANGELOG.md with entries for versions 1.0.37-1.0.40

## [1.0.40] - Pagination & Whitelist Support
### Fixed
- **200 Device Limit**: Fixed pagination issue where only the first 200 devices were fetched from SmartThings API. The plugin now follows `_links.next` to fetch all devices regardless of total count.
- **OAuth Token Refresh Bug**: Fixed critical bug where refresh tokens were not being saved after refresh in `auth.initialize()` and the 401 response interceptor. This caused "invalid_grant" errors after 24 hours for users who set up via the OAuth wizard.

### Added
- **ShowOnlyDevices (Whitelist)**: New configuration option to specify only the devices you want to expose to HomeKit. This is much easier than listing hundreds of devices to ignore when you only want a few.
  - Takes precedence over `IgnoreDevices` when configured
  - Case-insensitive matching with special character normalization
  - Useful for users with many SmartThings devices who only want to expose a subset

### Changed
- **OAuth Wizard**: Now saves `expires_in` value from SmartThings for accurate token expiry tracking instead of assuming 24 hours
- **Device Discovery Logging**: Now logs total number of devices discovered after fetching all pages

## [1.0.39] - OAuth Enhancements
### Fixed
- **OAuth Wizard Token Updates**: Fixed issue where re-running the OAuth wizard wouldn't update tokens if a token file already existed. The wizard now clears the old token file before saving new configuration.

### Changed
- **Improved Token Management**: Better handling of token file vs config token precedence

## [1.0.38] - Maintenance
### Changed
- Updated local settings and configurations
- Minor internal improvements

## [1.0.37] - Repository Cleanup
### Changed
- Updated .gitignore and .npmignore to include new exclusions
- Removed .claude folder from git tracking
- Enhanced settings configuration

## [1.0.36] - Cleanup
### Fixed
- Removed unnecessary files from npm package (nul, issues/)
- Updated .gitignore and .npmignore

## [1.0.35] - Documentation Update
### Changed
- **Enhanced README**: Added detailed step-by-step wizard instructions
  - Clear explanation of httpbin.org redirect and how to copy the authorization code
  - Example JSON response showing exactly what users will see
  - Troubleshooting section for common wizard issues
  - Re-authentication instructions

## [1.0.34] - OAuth Setup Wizard - No Tunnel Required!
### Added
- **OAuth Setup Wizard**: New 4-step UI wizard for easy OAuth authentication setup
  - No tunnel (ngrok/Cloudflare) required for initial setup
  - Uses httpbin.org as redirect URL to capture authorization code
  - Guided step-by-step process in Homebridge UI
  - Automatic token exchange and storage
- **Homebridge UI Integration**: Custom UI using `@homebridge/plugin-ui-utils`
  - Beautiful wizard interface with progress indicators
  - Form validation and error handling
  - Toast notifications for success/error states
- **Token Management Improvements**:
  - Tokens can now be loaded from config (wizard flow) or token file (existing flow)
  - Seamless migration for existing users

### Changed
- **Server URL Now Optional**: No longer required for basic setup
  - Only needed if you want webhook-based real-time updates
  - Webhook server only starts when server_url is configured
- **Webhook Port Now Optional**: Defaults to 3000, only used with webhooks
- **Improved Auth Flow Messages**: Better guidance when authentication is needed
  - Points users to the UI wizard instead of requiring manual URL visits
- **Updated README**: Simplified setup instructions focusing on the new wizard

### Technical Details
- Added `@homebridge/plugin-ui-utils` and `simple-oauth2` dependencies
- Created `homebridge-ui/server.js` for OAuth token exchange endpoints
- Created `homebridge-ui/public/index.html` for wizard UI
- Updated `config.schema.json` with `customUi: true` and new token fields
- Updated `TokenManager` to support loading tokens from config
- Updated `WebhookServer` to be optional (only starts with server_url)

## [1.0.33] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **Bug Fixes**: Bug fixes
## [1.0.32] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component 
## [1.0.31] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.30] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.29] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.28] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.27] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.26] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Bug fixes**
## [1.0.25] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Bug fixes**
## [1.0.24] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Bug fixes**
## [1.0.23] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control

## [1.0.21] - Samsung TV Custom Input Names & Simplified Experience
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control
  
## [1.0.20] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **🔊 Samsung TV Volume Control**: fixed audio issue with homekit

## [1.0.19] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **🔊 Samsung TV Volume Control**: fixed audio issue with homekit

## [1.0.18] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume does not apear in homekit
## [1.0.17] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control
  
## [1.0.16] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control

### Added
- **🏷️ Dynamic Input Source Names**: Samsung TV custom input names now display properly in HomeKit
  - Shows custom names like "PlayStation 5", "Apple TV" instead of generic "HDMI1", "HDMI2"
  - Automatically fetches fresh custom names from Samsung TV during device registration
  - Fallback to generic names if custom names not available
  - Focused on physical input sources only for clean, simple experience
- **🎚️ Volume Slider Accessory**: Added separate lightbulb accessory for TV volume control
  - Configurable via `registerVolumeSlider: boolean` option (default: false)
  - Volume appears as brightness slider (0-100%), mute as on/off toggle
  - Shows as separate accessory in Home app for easy volume access
- **📖 Official Capability Validation**: All commands now validate against official SmartThings capability specifications
- **🔄 Smart Command Fallbacks**: Multiple command strategies for better device compatibility
- **📊 Enhanced Logging**: Detailed logging with ✅/❌ indicators for successful/failed commands
- **⏱️ Improved Timing**: Optimized status refresh timing for better command verification

### Changed
- **🔇 Speaker State Management**: Speaker active/inactive state now properly reflects TV power and mute status
- **📱 HomeKit Integration**: Improved native TV interface experience with proper audio controls
- **🎚️ Volume Control**: Enhanced volume slider responsiveness with Samsung TV-specific unmute logic
- **🔧 Command Processing**: All commands now follow official SmartThings capability specifications
- **🎛️ Remote Control**: Remote keys now properly map to official SmartThings capabilities

### Technical Details
- Implemented official audioVolume capability (integer 0-100, setVolume command, volumeUp/volumeDown)
- Implemented official audioMute capability (setMute with "muted"/"unmuted", mute/unmute fallbacks)
- Implemented official mediaInputSource capability (setInputSource with enum values)
- Implemented official mediaPlayback capability (play, pause, stop, rewind, fastForward)
- Implemented official tvChannel capability (channelUp, channelDown, setTvChannel)
- Added capability detection before sending commands to prevent unsupported operations
- Enhanced service linking architecture following HomeKit Television service specifications
- Improved event processing for synchronized TV and speaker state updates

## [1.0.15] - Television Service Support & IgnoreDevices Bug Fixes
### Added
- **🎬 Television Service**: Samsung TVs now appear as proper Television accessories in HomeKit instead of simple switches
- **📺 Input Source Control**: Full support for HDMI inputs, TV tuner, and custom input names from SmartThings
- **🔊 Audio Controls**: Complete volume control, mute/unmute, and volume up/down buttons via TelevisionSpeaker service
- **🎨 Picture Mode Support**: Control Samsung picture modes (Standard, Dynamic, Movie, etc.) from HomeKit
- **🎮 Remote Control**: Support for media playback controls (rewind, fast forward, channel up/down)
- **🔇 TelevisionSpeaker Integration**: Proper speaker service with Active characteristic and volume bounds (0-100)
- **⚙️ Configuration Options**:
  - `enableTelevisionService` (default: true) - Enable/disable Television service for TV devices
  - `removeLegacySwitchForTV` (default: false) - Option to remove legacy switch service for TVs
  - `PollTelevisionsSeconds` (default: 15) - TV-specific polling interval

### Fixed
- **🔧 IgnoreDevices Functionality**: Fixed multiple issues that prevented the `IgnoreDevices` configuration from working properly
  - Fixed Unicode character handling for device names with smart quotes (`'`) and special characters
  - Added proper input validation to ensure `IgnoreDevices` is configured as an array of strings
  - Fixed whitespace trimming in device name comparisons
  - Added comprehensive debug logging to help troubleshoot ignore list issues
- **📖 Configuration Documentation**: Enhanced `config.schema.json` with better descriptions and examples for `IgnoreDevices`

### Changed
- **🔍 Smart TV Detection**: Automatic detection of Samsung TVs based on device capabilities
- **🏠 HomeKit Category**: TVs now appear with proper Television icon and controls in Home app
- **📊 Capability Mapping**: Enhanced capability detection to include TV-specific Samsung capabilities
- **🐛 Device Name Normalization**: Device names and ignore list entries are now properly normalized for consistent matching
- **⚠️ Error Handling**: Added warning messages for invalid `IgnoreDevices` configuration formats

### Technical Details
- Created `TelevisionService` class extending `BaseService`
- TV detection based on `samsungvd.deviceCategory`, `samsungvd.mediaInputSource`, audio capabilities, and TV channels
- Proper HomeKit Television service implementation with primary service designation
- TelevisionSpeaker service with both absolute and relative volume control support
- Speaker Active characteristic properly linked to TV power and mute states
- Volume characteristics with proper bounds (0-100) and step increments
- Maintains backward compatibility - existing Switch services continue working
- Stable UUIDs prevent service duplication across restarts
- Graceful fallback for missing TV capabilities
- Enhanced character normalization using Unicode regex patterns (`\u2018`, `\u2019`, `\u201C`, `\u201D`)
- Added debug logs showing device name comparisons: `"normalized_device_name" vs "normalized_ignore_name"`
- Improved error messages guide users to correct configuration format
- Case-insensitive matching with automatic whitespace trimming

### Migration Notes
- **Non-breaking**: Existing TV devices will automatically upgrade to Television service on next restart
- **Legacy Support**: Original switch functionality preserved by default
- **No User Action Required**: TV detection and upgrade happens automatically

## [1.0.9] - Homebridge v2.0 Compatibility
### Added
- **Homebridge v2.0 Support**: Added support for Homebridge v2.0.0-beta.0 and above
- **HAP-NodeJS v1 Compatibility**: Updated to comply with HAP-NodeJS v1 breaking changes
- **Crash Loop Recovery**: Added `handleCrashLoopRecovery()` method for improved error handling

### Changed
- **BatteryService Rename**: Renamed `BatteryService` class to `Battery` to comply with HAP-NodeJS v1 changes
- **Package.json Engines**: Updated to support both Homebridge v1.6.0+ and v2.0.0-beta.0+
- **Backward Compatibility**: Maintained full compatibility with Homebridge v1.x

### Technical Details
- Updated `package.json` engines field to `"^1.6.0 || ^2.0.0-beta.0"`
- Renamed `BatteryService` to `Battery` in `src/services/batteryService.ts`
- Updated capability map in `src/multiServiceAccessory.ts`
- Added crash loop recovery method in `src/auth/auth.ts`
- Verified existing code already complies with HAP-NodeJS v1 requirements

### Notes
- The plugin is now ready for Homebridge v2.0 testing
- All existing functionality is preserved
- No breaking changes for existing users
- Comprehensive migration documentation provided

## [1.0.8]
### Fixed
- Corrected `.npmignore` file to ensure the compiled `dist` directory is included in the published package, resolving installation failures during Homebridge verification.

## [Released]

## [1.0.7]
### Fixed
- Addressed an issue where setting the fan speed to 0% in HomeKit would incorrectly turn off the air conditioner instead of setting the fan mode to 'Auto'. Implemented a mechanism in `AirConditionerService` to correctly handle this sequence and maintain the 'Auto' fan mode.

## [1.0.6] 
### Changed
- Updated minimum required Node.js version to v20.0.0. Adjusted `engines` field in `package.json` accordingly.
- Tested compatibility with Node.js v20.

## [1.0.5]
### Changed
- Corrected and updated CHANGELOG.md details for version 1.0.4.

## [1.0.4]
### Added
- Support for selecting "Speed and Windfree" under "Optional Mode For Air Conditioners" in the configuration. This option exposes separate HomeKit switches for the Speed and WindFree modes.
- Added descriptive text and a link to setup instructions ([README](https://github.com/aziz66/homebridge-smartthings?tab=readme-ov-file#instructions)) for the `client_id` and `client_secret` fields in the plugin configuration UI (`config.schema.json`).

### Changed
- Refactored optional mode handling in `AirConditionerService` to support creating multiple switches (`Speed`, `WindFree`) based on the single "Speed and Windfree" configuration value.
- Updated `config.schema.json` to hide the `AccessToken` and `WebhookToken` fields from the Homebridge configuration UI, as these are handled automatically by the OAuth2 flow and persistent storage.

### Fixed
- Resolved TypeScript build error `TS2345: Argument of type 'OptionalMode | undefined' is not assignable...` by adding a non-null assertion (`!`) where `this.optionalMode` is used in the single-mode setup path within the constructor of `AirConditionerService`, ensuring type safety in that specific code path.