# Configuration Reference

Every setting available in `config.schema.json`, in the order it appears in the Homebridge UI form. The Homebridge UI shows the same descriptions inline next to each field — this page is a single-pager for users who configure via JSON or want to see everything at once.

> The plugin alias is `HomeBridgeSmartThings` (platform). Configuration lives under the `platforms` array of `~/.homebridge/config.json`.

---

## Connection & authentication

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `Smartthings Plug (IK)` | Display name in Homebridge logs. |
| `BaseURL` | string | `https://api.smartthings.com/v1/` | SmartThings API base URL. Don't change unless you know what you're doing. |
| `client_id` | string | *(required)* | OAuth2 Client ID from `smartthings apps:create`. |
| `client_secret` | string | *(required)* | OAuth2 Client Secret from `smartthings apps:create`. Save this securely — it can't be retrieved later. |
| `server_url` | string | *(empty)* | Public tunnel URL for webhooks. Leave empty for polling-only mode. See [Webhooks and Real-Time Updates](https://github.com/aziz66/homebridge-smartthings/wiki/Webhooks-and-Real-Time-Updates). |
| `oauth_access_token` | string | *(auto)* | Auto-filled by the OAuth wizard. **Don't edit manually.** |
| `oauth_refresh_token` | string | *(auto)* | Auto-filled by the OAuth wizard. **Don't edit manually.** |
| `oauth_expires_in` | integer | *(auto)* | Auto-filled by the OAuth wizard. **Don't edit manually.** |
| `webhook_port` | integer | `3000` | Local port the webhook server listens on. Only used if `server_url` is set. |

---

## Polling intervals

All intervals are in seconds. Set to `0` to disable polling for that device class entirely (only safe if you have webhooks configured). SmartThings real-time subscriptions provide push updates when available; polling is the fallback.

| Field | Default (sec) | Description |
|---|---|---|
| `GarageDoorMaxPoll` | `40` | Max polls before giving up while a garage door is moving. |
| `PollLocksSeconds` | `10` | Lock state. |
| `PollDoorsSeconds` | `10` | Garage door state. |
| `PollSensorsSeconds` | `5` | Motion, contact, leak, smoke, CO, occupancy, temperature, humidity, light. |
| `PollSecuritySystemsSeconds` | `15` | SmartThings security panels. |
| `PollSwitchesAndLightsSeconds` | `10` | Switches, lights, fans. |
| `PollTelevisionsSeconds` | `15` | Samsung TVs (TVs respond more slowly than other devices, so a higher interval is recommended). |
| `PollWindowShadesSeconds` | `20` | Window shades and blinds. |

---

## Device-specific options

### Air conditioners

| Field | Type | Default | Description |
|---|---|---|---|
| `ExposeHumiditySensorForAirConditioners` | boolean | `false` | Expose the AC's humidity sensor as a separate HomeKit accessory if available. |
| `ExposeACDisplayLight` | boolean | `true` | Expose the AC display light as a switch if available. |
| `OptionalModeForAirConditioners` | string enum | `None` | Add an extra switch on AC accessories for an optional mode. Options: `None`, `Sleep`, `Speed`, `WindFree`, `WindFreeSleep`, `Speed and Windfree`. |

### Laundry & appliances

| Field | Type | Default | Description |
|---|---|---|---|
| `ExposeContactSensorForWashers` | boolean | `false` | Add a contact sensor to washers (enables HomeKit Activity Notifications when a cycle completes). |
| `ExposeContactSensorForDryers` | boolean | `false` | Add a contact sensor to dryers (Activity Notifications). |
| `ExposeContactSensorForDishwashers` | boolean | `false` | Add a contact sensor to dishwashers (Activity Notifications). |
| `removeLegacySwitchForLaundry` | boolean | `false` | Suppress the auto-generated Switch tile on washers, dryers, and dishwashers. The Valve tile (Active/InUse and remaining duration) and any optional Contact Sensor are unaffected. |

### Refrigerators

| Field | Type | Default | Description |
|---|---|---|---|
| `ExposeMultiZoneRefrigerator` | boolean | `false` | For Samsung Family Hub fridges with multiple compartments (Fridge, Freezer, FlexZone, CVRoom). When enabled, the plugin parses Samsung's OCF driver-state data so each compartment reports its own temperature, and skips creating tiles for compartments you've disabled in the SmartThings app. Standard single-zone fridges are unaffected. Tested against US-region firmware (RF29DB9600QLA); metric-region devices may report OCF in Celsius — please open an issue if temperatures look wrong. |

### Televisions

| Field | Type | Default | Description |
|---|---|---|---|
| `enableTelevisionService` | boolean | `true` | Expose Samsung TVs as proper Television accessories with input source, volume, and picture mode controls. When disabled, TVs appear as simple switches. |
| `removeLegacySwitchForTV` | boolean | `false` | Remove the basic switch service for TVs, leaving only the Television service. When disabled (default), both services are available for backward compatibility. |
| `registerVolumeSlider` | boolean | `true` | Adds a separate volume slider accessory (exposed as a lightbulb) for TVs, because HomeKit's native TV interface doesn't show volume controls directly. |
| `tvApps` | array of app IDs | `[]` | TV app shortcuts that appear as input sources. See [Samsung Frame TV → TV App Launcher](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV#tv-app-launcher). |
| `frameTvDevices` | array of objects | `[]` | Per-device Samsung Frame TV configuration (local WebSocket control). See [Samsung Frame TV](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV). |

`frameTvDevices` items:

| Sub-field | Type | Default | Description |
|---|---|---|---|
| `deviceName` | string | *(required)* | Exact SmartThings device name (case-insensitive). |
| `ip` | string | *(required)* | TV's local IPv4 address. Set a static IP for reliability. |
| `enableFullPowerOff` | boolean | `true` | Use a 3.5s long-press of KEY_POWER via local WebSocket instead of `switch.off` (which only enters Art Mode on Frame TVs). |
| `enableArtModeSwitch` | boolean | `true` | Expose a separate switch in HomeKit to toggle Art Mode on/off. |
| `token` | string | *(auto)* | Authorization token from the TV. Usually auto-saved after the first connection — leave empty unless troubleshooting. |

### Thermostats

| Field | Type | Default | Description |
|---|---|---|---|
| `thermostatModeOverrides` | array of objects | `[]` | Override the SmartThings `thermostatMode` sent for HEAT/COOL on a per-device basis. Only needed for HVAC systems with non-standard modes (e.g. Koolnova `radiatingfloor`). Devices not listed use the defaults `heat`/`cool`. |

`thermostatModeOverrides` items:

| Sub-field | Type | Default | Description |
|---|---|---|---|
| `deviceName` | string | *(required)* | Exact SmartThings device name (case-insensitive). |
| `heatMode` | string | `heat` | SmartThings mode to send when HomeKit requests HEAT (e.g. `heat`, `radiatingfloor`). |
| `coolMode` | string | `cool` | SmartThings mode to send when HomeKit requests COOL. |

---

## Device filtering

| Field | Type | Description |
|---|---|---|
| `IgnoreLocations` | array of strings | Locations whose devices should never be exposed to HomeKit. |
| `IgnoreDevices` | array of strings | Device names to skip (case-insensitive, whitespace-trimmed, smart quotes normalized). Ignored if `ShowOnlyDevices` is set. |
| `ShowOnlyDevices` | array of strings | Whitelist: when set, **only** these devices are exposed. Takes precedence over `IgnoreDevices`. Useful when you have many devices but only want a few in HomeKit. |

---

## Real-time subscriptions

| Field | Type | Default | Description |
|---|---|---|---|
| `selectedCapabilities` | array of strings (max 20) | `[]` | Manually pick which capabilities get real-time webhook subscriptions. Leave empty for automatic prioritization by device count. SmartThings limits subscriptions to 20 per app. The Homebridge UI provides a checkbox-based picker that's easier than editing this directly. See [Webhooks and Real-Time Updates → Managing Real-Time Subscriptions](https://github.com/aziz66/homebridge-smartthings/wiki/Webhooks-and-Real-Time-Updates#managing-real-time-subscriptions). |

---

## Example minimal config

```json
{
  "platforms": [
    {
      "platform": "HomeBridgeSmartThings",
      "name": "Smartthings Plug (IK)",
      "BaseURL": "https://api.smartthings.com/v1/",
      "client_id": "7a850484-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "client_secret": "3581f317-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "GarageDoorMaxPoll": 40
    }
  ]
}
```

The OAuth wizard fills in `oauth_access_token`, `oauth_refresh_token`, and `oauth_expires_in` automatically after you complete it.
