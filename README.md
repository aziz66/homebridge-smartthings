
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

A modern SmartThings plugin for Homebridge that provides seamless integration with your SmartThings devices. This plugin features automatic device discovery, OAuth authentication, and access token refresh capabilities.

## Features

- **No Legacy App Required**: Works with the new SmartThings app and API
- **Automatic Device Discovery**: Automatically finds and adds your SmartThings devices
- **Device Management**: Automatically removes devices that are no longer in your SmartThings network
- **OAuth Support**: Secure authentication with automatic token refresh
- **Easy Setup Wizard**: New UI-based OAuth wizard - no tunnel required!

## Prerequisites

Before you begin, ensure you have the following:

- **Homebridge**: A working Homebridge installation with UI access
- **SmartThings CLI**: [Download and install](https://github.com/SmartThingsCommunity/smartthings-cli#readme) the official SmartThings CLI tool

---

## Installation Guide

### Step 1: Install the Plugin

1. Open your Homebridge web interface (usually http://localhost:8581)
2. Go to the **"Plugins"** tab
3. Search for `Homebridge Smartthings oAuth Plugin`
4. Click **"Install"**

---

### Step 2: Create SmartThings App

You need to create a SmartThings OAuth application using the SmartThings CLI. This is a one-time setup.

1. **Open a terminal/command prompt and run**:
   ```bash
   smartthings apps:create
   ```

2. **Follow the prompts exactly as shown below**:

   | Prompt | What to Enter |
   |--------|---------------|
   | **App Type** | Select `OAuth-In App` |
   | **Display Name** | `Homebridge SmartThings` (or any name you like) |
   | **Description** | `Homebridge integration` |
   | **Icon Image URL** | Press Enter to skip |
   | **Target URL** | `https://httpbin.org/get` |
   | **Scopes** | Select: `r:devices:*`, `x:devices:*`, `r:locations:*` |
   | **Redirect URI** | `https://httpbin.org/get` |

   > **Important**: Make sure to use `https://httpbin.org/get` for both Target URL and Redirect URI. This is what makes the wizard work without needing a tunnel!

3. **Save your credentials immediately!**

   After creation, you'll see output like this:
   ```
   OAuth Info (you will not be able to see the OAuth info again so please save it now!):
   ───────────────────────────────────────────────────────────
    OAuth Client Id      7a850484-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    OAuth Client Secret  3581f317-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ───────────────────────────────────────────────────────────
   ```

   > **Critical**: Copy and save both the **Client ID** and **Client Secret** somewhere safe. You cannot retrieve them later!

---

### Step 3: Use the OAuth Setup Wizard

Now open the plugin settings in Homebridge UI to complete the OAuth setup.

1. Go to your Homebridge web interface
2. Navigate to **Plugins** tab
3. Find **"Homebridge Smartthings oAuth Plugin"** and click the **Settings** (gear icon)
4. Click the **"Open OAuth Setup Wizard"** button

---

### Step 4: Complete the Wizard Steps

The wizard has 4 steps:

#### Wizard Step 1: Enter SmartThings App Credentials
- Enter the **OAuth Client ID** from Step 2
- Enter the **OAuth Client Secret** from Step 2
- Click **"Next"**

#### Wizard Step 2: SmartThings Login
- Click **"Next"** - this will open a new browser window/tab
- You'll be taken to the SmartThings login page
- Log in with your Samsung/SmartThings account
- Select the **location** you want to use
- Click **"Authorize"** to grant permissions

#### Wizard Step 3: Copy the Authorization Code
After authorizing, you'll be redirected to **httpbin.org** which displays a JSON response like this:

```json
{
  "args": {
    "code": "hkp89A"
  },
  "headers": {
    "Accept": "text/html,application/xhtml+xml,...",
    "Host": "httpbin.org",
    ...
  },
  "origin": "xxx.xxx.xxx.xxx",
  "url": "https://httpbin.org/get?code=hkp89A"
}
```

**What to do:**
1. Look for the `"args"` section at the top
2. Find the `"code"` value (e.g., `"hkp89A"`)
3. **Copy ONLY the code value** (just `hkp89A`, without quotes)
4. Go back to the Homebridge wizard
5. Paste the code into the **"Authorization Code"** field
6. Click **"Next"**

#### Wizard Step 4: Save Configuration
- The wizard will automatically exchange your code for access tokens
- You'll see the **Access Token** and **Refresh Token** fields populated
- Click **"Save Configuration"**
- You'll see a success message

---

### Step 5: Restart Homebridge

After saving the configuration:
1. Go to the Homebridge main page
2. Click **"Restart Homebridge"**
3. Wait for Homebridge to restart
4. Your SmartThings devices should now appear in HomeKit!

---

## You're Done!

Your SmartThings devices should now appear in HomeKit! The plugin will automatically:
- Discover all compatible devices
- Add them to HomeKit
- Remove devices that are no longer available
- Refresh access tokens automatically (no manual intervention needed)

---

## Advanced: Webhooks for Real-Time Updates (Optional)

By default, the plugin uses polling to check device status every few seconds. If you want **real-time device updates**, you can configure webhooks so SmartThings pushes events directly to the plugin the instant a device changes state. Polling continues to run alongside webhooks as a fallback.

### How It Works

When configured, the plugin:
1. Starts a webhook server on the configured port (default `3000`)
2. Registers broad capability subscriptions with SmartThings so it receives device events in real-time
3. Continues polling as normal -- webhooks are purely additive, not a replacement

### Prerequisites

- A **publicly accessible URL** that SmartThings can reach (via a tunnel service or port forwarding)
- Your SmartThings app must be registered as a **Webhook SmartApp** with the correct Target URL

### Setting Up Webhooks

#### 1. Set up a secure tunnel

Use [ngrok](https://ngrok.com/), [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), or any reverse proxy to expose your Homebridge instance:

```bash
ngrok http --url=your-domain.ngrok-free.app 3000
```

Your public URL will be something like `https://your-domain.ngrok-free.app`.

#### 2. Create the SmartThings App with your webhook URL

When creating your SmartThings app (see Step 2 above), use your public tunnel URL instead of `httpbin.org`:

| Prompt | What to Enter |
|--------|---------------|
| **Target URL** | `https://your-domain.ngrok-free.app` (your public URL -- this is where SmartThings sends device events) |
| **Redirect URI** | `https://your-domain.ngrok-free.app/oauth/callback` (this is the OAuth callback endpoint) |

> **Important**: The **Redirect URI** must include the `/oauth/callback` path. This is the endpoint the plugin uses to complete the OAuth authorization flow. The **Target URL** should be your base URL without any path -- SmartThings will POST lifecycle events (PING, EVENT, etc.) to this root URL.

If you already created the app with `httpbin.org`, you can update it using the SmartThings CLI:
```bash
smartthings apps:update <app-id>
```

#### 3. Update plugin configuration

In the Homebridge UI plugin settings:
- Set **Server URL** to your tunnel URL (e.g., `https://your-domain.ngrok-free.app`)
- Set **Webhook Port** to `3000` (or whichever port your tunnel points to)

#### 4. Restart Homebridge

After saving, restart Homebridge. Check the logs for:
- `Webhook server listening on port 3000` -- the server started
- `Successfully flushed existing subscriptions` -- old subscriptions cleared
- `Creating X broad CAPABILITY subscriptions...` -- real-time subscriptions being set up
- `SmartThings real-time subscriptions set up successfully.` -- all done

### URL Reference

| URL | Purpose |
|-----|---------|
| `https://your-domain.ngrok-free.app` | **Target URL** in SmartThings app settings. SmartThings sends lifecycle events (PING, CONFIRMATION, EVENT) here. |
| `https://your-domain.ngrok-free.app/oauth/callback` | **Redirect URI** in SmartThings app settings. Used during OAuth authorization to receive the auth code. |

### Plugin Configuration Fields

After creating your SmartThings app and setting up the tunnel, fill in these fields in the Homebridge plugin settings:

| Field | Example | Description |
|-------|---------|-------------|
| **Client ID** | `7a850484-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | The OAuth Client ID from the `smartthings apps:create` output. |
| **Client Secret** | `3581f317-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | The OAuth Client Secret from the same output. Save this — you can't retrieve it later. |
| **Server URL** | `https://your-domain.ngrok-free.app` | Your public tunnel URL (the root, no trailing path). This tells the plugin to start the webhook server and register subscriptions. Leave empty if you only want polling. |
| **Webhook Port** | `3000` | The local port the webhook server listens on. Must match what your tunnel forwards to. Default is `3000`. |

> **Note**: The **Server URL** is the same root URL you used as the **Target URL** when creating the SmartThings app. The plugin uses it both to start the local webhook server and to build the OAuth callback endpoint (`/oauth/callback`).

### Managing Real-Time Subscriptions

Once webhooks are working, you can control which capabilities get real-time subscriptions (max 20) from the Homebridge UI — no restart required.

1. Open plugin settings in the Homebridge UI
2. Below the OAuth wizard button, you'll see the **Real-Time Subscription Manager** card
3. The card shows all capabilities discovered from your devices, sorted by device count
4. Check the capabilities you want subscribed in real-time (up to 20)
5. Click **"Save & Apply Subscriptions"** to flush the old subscriptions and create new ones immediately

**Tips:**
- Leave all unchecked to use automatic prioritization (most devices first)
- Use **"Auto (by device count)"** to quickly select the top 20
- The capability list refreshes each time Homebridge restarts and discovers devices
- Changes take effect immediately — no plugin restart needed

### Troubleshooting Webhooks

**"SmartThings subscriptions will not be set up"**
- This means the plugin couldn't discover the `installedAppId`. Make sure your SmartThings app is installed to your location.
- If you see a 403 error, your OAuth token may not have sufficient scopes. Re-authorize through the wizard.

**"Webhook server listening but no events arriving"**
- Verify your tunnel is working by visiting your public URL in a browser
- Check that the Target URL in your SmartThings app settings matches your tunnel URL exactly
- SmartThings will send a PING challenge first -- check logs for `Received SmartThings PING challenge`

**Events are working but some devices don't update in real-time**
- SmartThings limits subscriptions to 20 per app. If you have more than 20 unique capabilities, lower-priority ones will remain polling-only. Check the logs for details on which capabilities are subscribed.

---

## Samsung Frame TV Support (Optional)

Samsung Frame TVs behave differently from standard TVs: when the SmartThings API sends a power-off command, the TV enters **Art Mode** instead of truly shutting down. This plugin provides optional local WebSocket control to fix this, enabling true power off and an Art Mode toggle switch in HomeKit.

### Auto-Detection

The plugin automatically detects Frame TVs by checking the `artSupported` field reported by SmartThings. If your TV supports Art Mode, you'll see a log message during startup:

> `Frame TV detected: "Living Room TV" reports artSupported=true. To enable full power off and Art Mode control, add this device to the "frameTvDevices" config with its local IP address.`

The local IP address cannot be auto-detected from SmartThings, so you'll need to provide it manually in the configuration.

### What It Does

- **Full Power Off** (optional, enabled by default): Sends a 3.5-second long-press of the power key via local WebSocket, which fully powers down the TV instead of entering Art Mode
- **Art Mode Switch** (optional, enabled by default): Exposes a separate switch in HomeKit to toggle Art Mode on and off
- Power **on** continues to work through the SmartThings API as normal

### Configuration Options

You can choose how the plugin handles your Frame TV:

| Setting | Effect |
|---------|--------|
| **Full Power Off = ON** (default) | Turning off the TV in HomeKit sends a full power off via local WebSocket. Art Mode switch controls Art Mode separately. |
| **Full Power Off = OFF** | Turning off the TV in HomeKit uses the standard SmartThings command (which enters Art Mode on Frame TVs). Useful if you prefer the default Samsung behavior. |
| **Art Mode Switch = ON** (default) | A separate "Art Mode" switch appears in HomeKit for toggling Art Mode on/off. |
| **Art Mode Switch = OFF** | No Art Mode switch. The TV behaves like a standard TV in HomeKit. |

This means you can mix and match. For example, you could disable Full Power Off but still have the Art Mode switch — giving you the standard Samsung power behavior plus manual Art Mode control.

### Setup

1. Open plugin settings in the Homebridge UI
2. Scroll down to the **"Samsung Frame TV Settings"** section
3. Click **"Add Frame TV Device"**
4. Enter the **device name** (must match exactly how it appears in SmartThings, case-insensitive)
5. Enter the **TV's local IP address** (assign a static IP on your router for reliability)
6. Toggle **Full Power Off** and **Art Mode Switch** as desired
7. Save and restart Homebridge

### First-Time TV Pairing

When Homebridge starts with a Frame TV configured, the plugin will attempt to establish a local WebSocket connection to the TV. On the first connection, the TV needs to authorize the plugin:

1. Make sure the TV is **powered on** before starting Homebridge
2. After Homebridge starts, a popup will appear on the TV screen asking to allow the connection
3. Using your TV remote, select **"Allow"** on the popup
4. The plugin will automatically save an authorization token for future connections — the popup will not appear again

If the pairing fails (e.g., the TV was off or the popup timed out), the plugin will log an error. Simply restart Homebridge with the TV on to retry the pairing process.

### If You Clicked "Deny" by Mistake

If you accidentally denied the connection, the TV remembers this decision and will reject all future connection attempts. To fix this:

1. On your TV, go to **Settings > General > External Device Manager > Device Connection Manager > Device List**
2. Find the "Homebridge SmartThings" entry and either change its permission to **Allow** or remove the entry entirely
3. Restart Homebridge to initiate a new pairing

### Troubleshooting Frame TV

**"Connection timeout" errors in the logs**
- Verify the TV is powered on and connected to the same network as Homebridge
- Confirm the IP address is correct (check your router's DHCP client list)
- Make sure no firewall is blocking port 8001 (Art Mode) or port 8002 (remote control)

**"Authorization denied by TV" errors**
- The saved token may have expired or been invalidated. The plugin will automatically clear the old token. Restart Homebridge with the TV on to get a new authorization popup.

**Art Mode switch not appearing**
- The Art Mode switch is enabled by default. Check that it hasn't been disabled in the Frame TV device settings.
- Restart Homebridge after changing the configuration
- The Art Mode switch appears as a separate tile in HomeKit, not inside the TV accessory

---

## TV App Launcher (Optional)

Launch Samsung TV apps directly from the HomeKit TV input picker. Apps appear as additional input sources alongside your HDMI inputs.

### Setup

1. Open plugin settings in the Homebridge UI
2. Scroll to the **"TV App Shortcuts"** section
3. Select which apps to enable (Netflix, YouTube, Disney+, Shahid, and more)
4. Save and restart Homebridge

Selected apps will appear in the input source list of your TV accessory in HomeKit. Selecting an app input will launch it on the TV using the `custom.launchapp` SmartThings capability.

No apps are enabled by default.

---

## Washer Support

Samsung washers with the `washerOperatingState` capability are automatically discovered and exposed as a HomeKit **Valve** accessory with:

- **Active**: Whether the washer is running
- **In Use**: Whether a wash cycle is in progress
- **Remaining Duration**: Countdown timer showing time left in the current cycle

No additional configuration is needed — washers are detected and added automatically during device discovery.

---

## Troubleshooting

### Common Issues

**"I don't see the OAuth wizard button"**
- Make sure you have the latest version of the plugin (1.0.34+)
- Try clearing your browser cache and refreshing the Homebridge UI

**"Authorization code is invalid"**
- Make sure you copied only the code value, not the entire JSON
- The code expires quickly - try the authorization process again
- Ensure you're copying from `args.code`, not from the URL

**"Plugin not finding devices after setup"**
- Verify your SmartThings app has the correct scopes: `r:devices:*`, `x:devices:*`, `r:locations:*`
- Make sure you selected the correct location during authorization
- Restart Homebridge after completing the wizard

**"Devices not responding"**
- Restart Homebridge
- Check that devices are online in the SmartThings app
- Check the Homebridge logs for error messages

### Re-running the Wizard

If you need to re-authenticate (e.g., tokens expired, changed SmartThings account):
1. Go to plugin settings
2. Click "Open OAuth Setup Wizard"
3. Complete all steps again
4. Restart Homebridge

### Getting Help

If you encounter issues:
1. Check the Homebridge logs for detailed error messages
2. Ensure all credentials are correct
3. Try re-running the OAuth wizard
4. Open an issue on [GitHub](https://github.com/aziz66/homebridge-smartthings/issues)

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and detailed release notes.

## Credits

This is a fork of the original homebridge-smartthings plugin created by [@iklein99](https://github.com/iklein99/), enhanced with OAuth support, automatic token refresh, and the new OAuth Setup Wizard.
