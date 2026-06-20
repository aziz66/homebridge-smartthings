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

On the first local connection, the TV needs to authorize the plugin. The plugin opens that connection the first time it needs to send a local command — i.e. the **first time you power the TV off from HomeKit** (or you can trigger it at startup, see below). On that first attempt the TV shows an **Allow/Deny** popup and the plugin waits up to ~30 seconds for you to respond:

1. Make sure the TV is **powered on**.
2. Power the TV **off** from the Home app (or restart Homebridge with the TV on — see the tip below). An **Allow/Deny** popup appears on the TV screen.
3. Using your TV remote, select **Allow** within ~30 seconds.
4. The plugin saves an authorization token for future connections — the popup will not appear again, and subsequent power-offs are instant.

> **Note:** this *first* power-off can take long enough that the Home app briefly shows the TV tile as "No Response." That's expected — the token is saved in the background, and the next press works normally.

> **Tip:** the smoothest way to pair without any time pressure is to **restart Homebridge while the TV is on**, then power the TV off from HomeKit and press Allow.

If the pairing fails (TV was off, popup timed out, etc.), the plugin logs an error and falls back to the standard SmartThings command for that press. Just try again with the TV on.

### Advanced: provide the token manually

If you can't catch the popup in time, or you're scripting setup, you can obtain a token yourself and paste it into the **TV Token** config field. The token is **bound to the app name**, so the external tool must connect using the exact name `Homebridge SmartThings` (case-sensitive) — otherwise the plugin's own connection will be rejected and the pasted token discarded.

Using the [`samsungtvws`](https://pypi.org/project/samsungtvws/) Python tool, on any machine on the same network, with the TV **on**:

```python
pip install samsungtvws
```
```python
from samsungtvws import SamsungTVWS
tv = SamsungTVWS(host='192.168.x.x', port=8002,
                 name='Homebridge SmartThings', token_file='token.txt')
tv.shortcuts().power()   # press ALLOW on the TV — this tool waits for you
print(open('token.txt').read().strip())   # the token string
```

Paste that token string into the Frame TV device's **TV Token** field, save, and restart Homebridge.

Alternatively, the plugin saves the token to a file named `samsung_tv_token_<ip>.json` (dots in the IP preserved) in the Homebridge storage folder — the same directory as `config.json`. When a token is first saved, its value and path are also printed to the Homebridge log.

## If you clicked "Deny" by mistake

The TV remembers a denied connection and will reject future attempts until you reset it:

1. On your TV: **Settings → General → External Device Manager → Device Connection Manager → Device List**.
2. Find the "Homebridge SmartThings" entry and either change its permission to **Allow** or remove the entry entirely.
3. Restart Homebridge to initiate a new pairing.

---

## Remote navigation & hardware volume buttons

Once a Frame TV is paired for local WebSocket control (see **First-time TV pairing** above), two extra controls light up via the TV's local remote channel:

- **Apple TV Remote D-pad** (Control Center → Remote): the arrows, **Select**, **Back**, **Exit**, and **Info** drive the TV directly. SmartThings' cloud API has no directional-key capability, so these only work on a paired Frame TV — on other TVs they remain inactive.
- **Hardware volume buttons**: the iPhone's physical volume buttons adjust TV volume. On a paired Frame the keypress goes over the local WebSocket for a snappy response; otherwise it falls back to the SmartThings cloud volume command.

Notes:
- These require the TV to be **paired first**. Pairing only ever happens on power-off (so the Allow popup never surprises you mid-navigation) — if the D-pad does nothing, power the TV off once from HomeKit and press **Allow**, then try again.
- If a keypress fails (TV off/unreachable) it's silently ignored rather than showing an error.
- After upgrading, you may need to **remove and re-add the TV** in the Apple Home app once for the hardware-volume control to appear (HomeKit caches the published accessory).

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

**Allow popup appears but disappears too fast to press it**

- This was a bug in versions up to 1.0.64 where the pairing connection timed out after only 2 seconds (see [#45](https://github.com/aziz66/homebridge-smartthings/issues/45)). Update to 1.0.65-beta.0 or later, which gives you ~30 seconds. If you can't update yet, use the **Advanced: provide the token manually** method above.

**"Authorization denied by TV" errors**

- The saved token may have expired or been invalidated. The plugin will automatically clear the old token. Restart Homebridge with the TV on to get a new authorization popup.

**Art Mode switch not appearing**

- The Art Mode switch is enabled by default. Check that it hasn't been disabled in the Frame TV device settings.
- Restart Homebridge after changing the configuration.
- The Art Mode switch appears as a separate tile in HomeKit, not inside the TV accessory.

For broader troubleshooting, see [Troubleshooting](https://github.com/aziz66/homebridge-smartthings/wiki/Troubleshooting).
