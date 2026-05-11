# Samsung Frame TV

Samsung Frame TVs behave differently from standard TVs: when the SmartThings API sends a power-off command, the TV enters **Art Mode** instead of truly shutting down. This plugin provides optional local WebSocket control to fix this — enabling true power off and an Art Mode toggle switch in HomeKit.

This page also covers the **TV App Launcher** (apps as input sources), since that feature applies to Frame TVs and other Samsung TVs alike.

---

## Auto-detection

The plugin automatically detects Frame TVs by checking the `artSupported` field reported by SmartThings. If your TV supports Art Mode, you'll see this in the startup log:

> `Frame TV detected: "Living Room TV" reports artSupported=true. To enable full power off and Art Mode control, add this device to the "frameTvDevices" config with its local IP address.`

The local IP address cannot be auto-detected from SmartThings, so you'll need to provide it manually in the configuration.

## What it does

- **Full Power Off** *(optional, enabled by default)*: Sends a 3.5-second long-press of the power key via local WebSocket — fully powers down the TV instead of entering Art Mode.
- **Art Mode Switch** *(optional, enabled by default)*: Exposes a separate switch in HomeKit to toggle Art Mode on and off.
- Power **on** continues to work through the SmartThings API as normal.

## Configuration options

| Setting | Effect |
|---|---|
| **Full Power Off = ON** *(default)* | Turning off the TV in HomeKit sends a full power off via local WebSocket. Art Mode switch controls Art Mode separately. |
| **Full Power Off = OFF** | Turning off the TV in HomeKit uses the standard SmartThings command (which enters Art Mode on Frame TVs). Useful if you prefer the default Samsung behavior. |
| **Art Mode Switch = ON** *(default)* | A separate "Art Mode" switch appears in HomeKit for toggling Art Mode on/off. |
| **Art Mode Switch = OFF** | No Art Mode switch. The TV behaves like a standard TV in HomeKit. |

You can mix and match — for example, disable Full Power Off but keep the Art Mode switch for the standard Samsung power behavior plus manual Art Mode control.

---

## Setup

1. Open plugin settings in the Homebridge UI.
2. Scroll down to the **Samsung Frame TV Settings** section.
3. Click **Add Frame TV Device**.
4. Enter the **device name** (must match exactly how it appears in SmartThings, case-insensitive).
5. Enter the **TV's local IP address** (assign a static IP on your router for reliability).
6. Toggle **Full Power Off** and **Art Mode Switch** as desired.
7. Save and restart Homebridge.

## First-time TV pairing

When Homebridge starts with a Frame TV configured, the plugin attempts to establish a local WebSocket connection. On the first connection the TV needs to authorize the plugin:

1. Make sure the TV is **powered on** before starting Homebridge.
2. After Homebridge starts, a popup will appear on the TV screen asking to allow the connection.
3. Using your TV remote, select **Allow**.
4. The plugin saves an authorization token for future connections — the popup will not appear again.

If the pairing fails (TV was off, popup timed out, etc.), the plugin logs an error. Restart Homebridge with the TV on to retry.

## If you clicked "Deny" by mistake

The TV remembers a denied connection and will reject future attempts until you reset it:

1. On your TV: **Settings → General → External Device Manager → Device Connection Manager → Device List**.
2. Find the "Homebridge SmartThings" entry and either change its permission to **Allow** or remove the entry entirely.
3. Restart Homebridge to initiate a new pairing.

---

## TV App Launcher

Launch Samsung TV apps directly from the HomeKit TV input picker. Apps appear as additional input sources alongside your HDMI inputs.

### Setup

1. Open plugin settings in the Homebridge UI.
2. Scroll to the **TV App Shortcuts** section.
3. Select which apps to enable (Netflix, YouTube, Disney+, Shahid, and more).
4. Save and restart Homebridge.

Selected apps will appear in the input source list of your TV accessory in HomeKit. Selecting an app input launches it on the TV using the `custom.launchapp` SmartThings capability.

No apps are enabled by default.

---

## Troubleshooting Frame TV

**"Connection timeout" errors in the logs**

- Verify the TV is powered on and connected to the same network as Homebridge.
- Confirm the IP address is correct (check your router's DHCP client list).
- Make sure no firewall is blocking port 8001 (Art Mode) or port 8002 (remote control).

**"Authorization denied by TV" errors**

- The saved token may have expired or been invalidated. The plugin will automatically clear the old token. Restart Homebridge with the TV on to get a new authorization popup.

**Art Mode switch not appearing**

- The Art Mode switch is enabled by default. Check that it hasn't been disabled in the Frame TV device settings.
- Restart Homebridge after changing the configuration.
- The Art Mode switch appears as a separate tile in HomeKit, not inside the TV accessory.

For broader troubleshooting, see [Troubleshooting](https://github.com/aziz66/homebridge-smartthings/wiki/Troubleshooting).
