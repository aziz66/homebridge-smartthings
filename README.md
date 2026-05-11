
<p align="center">

<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">

</p>

<p align="center">
<a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge" alt="verified-by-homebridge"></a>
<br>
<a href="https://www.npmjs.com/package/homebridge-smartthings-oauth"><img src="https://img.shields.io/npm/v/homebridge-smartthings-oauth?style=for-the-badge" alt="npm version"></a>
<a href="https://www.npmjs.com/package/homebridge-smartthings-oauth"><img src="https://img.shields.io/npm/dt/homebridge-smartthings-oauth?style=for-the-badge" alt="npm downloads"></a>
<a href="https://github.com/aziz66/homebridge-smartthings/stargazers"><img src="https://img.shields.io/github/stars/aziz66/homebridge-smartthings?style=for-the-badge" alt="GitHub stars"></a>
<br>
<a href="https://github.com/aziz66/homebridge-smartthings/issues"><img src="https://img.shields.io/github/issues/aziz66/homebridge-smartthings?style=for-the-badge" alt="GitHub issues"></a>
<a href="https://github.com/aziz66/homebridge-smartthings"><img src="https://img.shields.io/github/last-commit/aziz66/homebridge-smartthings?style=for-the-badge" alt="GitHub last commit"></a>
<a href="https://github.com/aziz66/homebridge-smartthings/releases"><img src="https://img.shields.io/github/v/release/aziz66/homebridge-smartthings?style=for-the-badge" alt="GitHub release"></a>
<br>
<a href="https://www.npmjs.com/package/homebridge-smartthings-oauth"><img src="https://img.shields.io/node/v/homebridge-smartthings-oauth?style=for-the-badge" alt="Node.js version"></a>
<a href="https://www.npmjs.com/package/homebridge-smartthings-oauth"><img src="https://img.shields.io/npm/l/homebridge-smartthings-oauth?style=for-the-badge" alt="license"></a>
<a href="https://ko-fi.com/aziz66"><img src="https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
</p>

# SmartThings Homebridge Plugin with OAuth Support

Connects your SmartThings devices to Apple HomeKit through Homebridge. Works with the modern SmartThings app and API, discovers devices automatically, and uses OAuth with token refresh — no legacy app, no manual token management.

## Features

- **No legacy app required** — works with the new SmartThings app and API.
- **Automatic device discovery** — devices are added (and removed) as your SmartThings network changes.
- **UI-based OAuth wizard** — set up authentication from the Homebridge UI without a public tunnel.
- **Optional real-time webhooks** — push updates from SmartThings for instant device state changes (polling continues as a fallback).
- **Broad device support** — lights, switches, climate, sensors, locks, security panels, washers/dryers/dishwashers, Samsung TVs (including Frame TVs), multi-zone refrigerators, and more.

## Supported Devices

The plugin automatically maps SmartThings capabilities to HomeKit accessories. At a glance:

| Category | What's exposed in HomeKit |
|---|---|
| **Lights & Switches** | On/off, dimming, color, color temperature |
| **Fans** | Speed control, fan + light combos |
| **Climate** | Thermostats, A/C units, air purifiers, temperature & humidity sensors |
| **Locks & Doors** | Smart locks, garage doors |
| **Window Coverings** | Shades and blinds (open/close + level) |
| **Sensors** | Motion, occupancy, contact, water leak, smoke, CO, illuminance, buttons |
| **Security Systems** | Arm/disarm panels with live alarm reporting |
| **Televisions** | Samsung TVs with input picker, volume, app launcher; full Frame TV control |
| **Appliances** | Washers, dryers, dishwashers, multi-zone Samsung Family Hub refrigerators |
| **Valves** | Smart water valves |
| **Battery** | Reported as a companion characteristic on supported devices |

For the full SmartThings-capability → HomeKit-service mapping, see [Supported Devices and Capabilities](https://github.com/aziz66/homebridge-smartthings/wiki/Supported-Devices-and-Capabilities) on the wiki.

## Quick Start

1. **Install the plugin** in the Homebridge UI: search for `Homebridge Smartthings oAuth Plugin` in the Plugins tab and click Install.
2. **Create a SmartThings OAuth app** with the [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli#readme) (`smartthings apps:create`). Save the Client ID and Client Secret.
3. **Open the OAuth Setup Wizard** from the plugin settings and follow the four wizard steps.
4. **Restart Homebridge** — your SmartThings devices appear in HomeKit.

> **Full walkthrough with screenshots, prompt-by-prompt CLI guidance, and the authorization-code copy step:** [Installation and OAuth Setup](https://github.com/aziz66/homebridge-smartthings/wiki/Installation-and-OAuth-Setup).

## Optional Features

**Real-time updates via webhooks.** Polling works out of the box; if you'd rather have SmartThings push events instantly, set up a public tunnel (ngrok, Cloudflare Tunnels) and configure the webhook URL. Polling continues to run as a fallback. → [Webhooks and Real-Time Updates](https://github.com/aziz66/homebridge-smartthings/wiki/Webhooks-and-Real-Time-Updates)

**Samsung Frame TV.** Frame TVs enter Art Mode when SmartThings sends "off" instead of truly powering down. The plugin can use a local WebSocket to send a true power-off command, plus expose an Art Mode toggle switch in HomeKit. → [Samsung Frame TV](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV)

**TV App Launcher.** Add Netflix, YouTube, Disney+, and other Samsung TV apps to the HomeKit input picker so you can launch them from a Home tile. → [Samsung Frame TV → TV App Launcher](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV#tv-app-launcher)

## Configuration

All configuration is done through the Homebridge UI form, which has inline descriptions for every field. For a single-page reference of every setting (type, default, when to use it), see [Configuration Reference](https://github.com/aziz66/homebridge-smartthings/wiki/Configuration-Reference).

## Troubleshooting & Help

- **Common problems** (OAuth, missing devices, webhook setup, Frame TV pairing): [Troubleshooting](https://github.com/aziz66/homebridge-smartthings/wiki/Troubleshooting)
- **Bug reports and feature requests**: [GitHub Issues](https://github.com/aziz66/homebridge-smartthings/issues)

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and detailed release notes.

## Credits

This is a fork of the original [homebridge-smartthings](https://github.com/iklein99/homebridge-smartthings) plugin by [@iklein99](https://github.com/iklein99/), enhanced with OAuth support, automatic token refresh, and the OAuth Setup Wizard.
