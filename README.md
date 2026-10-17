
<p align="center">

<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">

</p>

<p align="center">
<a href="https://github.com/TasleG/homebridge-smartthings/issues"><img src="https://img.shields.io/github/issues/TasleG/homebridge-smartthings?style=for-the-badge" alt="GitHub issues"></a>
<a href="https://github.com/TasleG/homebridge-smartthings"><img src="https://img.shields.io/github/last-commit/TasleG/homebridge-smartthings?style=for-the-badge" alt="GitHub last commit"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge" alt="license"></a>
</p>

> [!NOTE]
> **This is a community fork** of [aziz66/homebridge-smartthings](https://github.com/aziz66/homebridge-smartthings) (published on npm as `homebridge-smartthings-oauth`), which stopped being maintained after version **1.0.68**. This fork carries it forward with extra fixes and features, starting with control of the **Samsung air conditioner display light (LED)**.
>
> The fork is **not published on npm**. Installing the plugin from the Homebridge UI gets the original 1.0.68, not this fork. See [Installing this fork](#installing-this-fork).
>
> Tested with **Node.js 20.19+, 22.12+ and 24** and **Homebridge 1.6+ and 2.x**.

# SmartThings Homebridge Plugin with OAuth Support

Connects your SmartThings devices to Apple HomeKit through Homebridge. Works with the modern SmartThings app and API, discovers devices automatically, and uses OAuth with token refresh — no legacy app, no manual token management.

## What's new in this fork

### Samsung AC display light (LED) control

The original plugin showed the AC's display light as a HomeKit light but could not switch it: it sent `samsungce.airConditionerLighting` on/off, which many Samsung air conditioners accept and then ignore.

In this fork, tapping the **Display Light** tile switches the LED on the AC. When the AC supports the `execute` capability, the plugin sends the same command as the SmartThings API:

```json
{
  "component": "main",
  "capability": "execute",
  "command": "execute",
  "arguments": ["mode/vs/0", { "x.com.samsung.da.options": ["Light_Off"] }]
}
```

Samsung's option names are inverted: `Light_Off` turns the display **on** and `Light_On` turns it **off**. ACs without `execute` still get the original command.

**To use it:** tick **Expose AC Display Light as a light if available** (`ExposeACDisplayLight`) in the plugin settings and restart Homebridge. A *&lt;AC name&gt; Display Light* tile appears in the Home app. No URL, token or device ID is needed: the plugin uses your existing SmartThings login and finds the AC itself. If you used an HTTP webhook switch for the LED before, you can remove it.

## Features

- **No legacy app required** — works with the new SmartThings app and API.
- **Automatic device discovery** — devices are added (and removed) as your SmartThings network changes.
- **UI-based OAuth wizard** — set up authentication from the Homebridge UI without a public tunnel.
- **Optional real-time webhooks** — push updates from SmartThings for instant device state changes (polling continues as a fallback).
- **Broad device support** — lights, switches, climate, sensors, locks, security panels, washers/dryers/dishwashers, Samsung robot vacuums, Samsung TVs (including Frame TVs), multi-zone refrigerators, and more.

## Supported Devices

The plugin automatically maps SmartThings capabilities to HomeKit accessories. At a glance:

| Category | What's exposed in HomeKit |
|---|---|
| **Lights & Switches** | On/off, dimming, color, color temperature |
| **Fans** | Speed control, fan + light combos |
| **Climate** | Thermostats, A/C units (including the display light, opt-in via `ExposeACDisplayLight`), air purifiers, temperature & humidity sensors |
| **Locks & Doors** | Smart locks, garage doors |
| **Window Coverings** | Shades and blinds (open/close + level) |
| **Sensors** | Motion, occupancy, contact, water leak, smoke, CO, illuminance, buttons |
| **Security Systems** | Arm/disarm panels with live alarm reporting |
| **Televisions** | Samsung TVs with input picker, volume, app launcher; full Frame TV control |
| **Appliances** | Washers, dryers, dishwashers, Samsung robot vacuums (opt-in via `ExposeRobotVacuum`, exposed as a Switch — On = start cleaning, Off = return to dock), multi-zone Samsung Family Hub refrigerators |
| **Valves** | Smart water valves |
| **Battery** | Reported as a companion characteristic on supported devices |

For the full SmartThings-capability → HomeKit-service mapping, see [Supported Devices and Capabilities](https://github.com/aziz66/homebridge-smartthings/wiki/Supported-Devices-and-Capabilities) on the original project's wiki.

## Installing this fork

The fork is installed from source on the machine that runs Homebridge (Homebridge UI → Terminal, or SSH):

```bash
# 1. Download the source
cd ~
git clone https://github.com/TasleG/homebridge-smartthings.git
cd homebridge-smartthings

# 2. Build it and package it
npm ci
npm run build
npm pack        # creates homebridge-smartthings-oauth-<version>.tgz

# 3. Install it into Homebridge
sudo npm --prefix /var/lib/homebridge install ~/homebridge-smartthings/homebridge-smartthings-oauth-*.tgz
```

`/var/lib/homebridge` is the usual Homebridge folder on Raspberry Pi and Linux installs; on Docker it is usually `/homebridge`. Then restart Homebridge.

The fork uses the same package name as the original plugin, so it replaces an existing `homebridge-smartthings-oauth` install and keeps your settings and SmartThings login. To update later, run `git pull` in the source folder and repeat steps 2 and 3.

## First-time setup

If you have never used the plugin before, set up SmartThings access after installing:

1. **Create a SmartThings OAuth app** with the [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli#readme) (`smartthings apps:create`). Save the Client ID and Client Secret. The wizard expects the redirect URI `https://httpbin.org/get` by default — a public third-party echo service that simply displays the authorization code so you can copy it, which avoids needing a tunnel. If httpbin.org is unavailable, register a different redirect URI you control and enter it in the wizard instead.
2. **Open the OAuth Setup Wizard** from the plugin settings and follow the four wizard steps.
3. **Restart Homebridge** — your SmartThings devices appear in HomeKit.

> **Full walkthrough with screenshots, prompt-by-prompt CLI guidance, and the authorization-code copy step:** [Installation and OAuth Setup](https://github.com/aziz66/homebridge-smartthings/wiki/Installation-and-OAuth-Setup) on the original project's wiki.

## Optional Features

**Real-time updates via webhooks.** Polling works out of the box; if you'd rather have SmartThings push events instantly, set up a public tunnel (ngrok, Cloudflare Tunnels) and configure the webhook URL. Polling continues to run as a fallback. → [Webhooks and Real-Time Updates](https://github.com/aziz66/homebridge-smartthings/wiki/Webhooks-and-Real-Time-Updates)

**Samsung Frame & Tizen TV control.** Not just The Frame — works on Samsung Tizen TVs generally (OLED, QLED, Neo QLED, Crystal UHD; confirmed on the S90C OLED). Over a local WebSocket the plugin adds a true power-off (instead of SmartThings dropping the TV into Art/Ambient mode), an Art Mode toggle switch, the Apple TV Remote D-pad, and hardware volume buttons. → [Samsung Frame & Tizen TV Control](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV)

**TV App Launcher.** Add Netflix, YouTube, Disney+, and other Samsung TV apps to the HomeKit input picker so you can launch them from a Home tile. → [Samsung Frame TV → TV App Launcher](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV#tv-app-launcher)

## Configuration

All configuration is done through the Homebridge UI form, which has inline descriptions for every field. For a single-page reference of every setting (type, default, when to use it), see [Configuration Reference](https://github.com/aziz66/homebridge-smartthings/wiki/Configuration-Reference) on the original project's wiki.

## Troubleshooting & Help

- **Common problems** (OAuth, missing devices, webhook setup, Frame TV pairing): [Troubleshooting](https://github.com/aziz66/homebridge-smartthings/wiki/Troubleshooting)
- **Bug reports for this fork**: [GitHub Issues](https://github.com/TasleG/homebridge-smartthings/issues). Please don't report fork-specific problems to the original project. Redact secrets and tokens before pasting any config or logs.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and detailed release notes. Changes made in this fork are listed under **Unreleased**.

## Credits

- [@aziz66](https://github.com/aziz66) — the original [homebridge-smartthings](https://github.com/aziz66/homebridge-smartthings) OAuth plugin (up to 1.0.68) that this fork is based on, with OAuth support, automatic token refresh and the OAuth Setup Wizard, plus everyone who contributed to it.
- [@iklein99](https://github.com/iklein99/) — the original [homebridge-smartthings](https://github.com/iklein99/homebridge-smartthings) plugin that aziz66's version was forked from.

Licensed under the [Apache-2.0 license](./LICENSE), the same as the original project.
