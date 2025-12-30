
<p align="center">

<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">

</p>

<p align="center">
<a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge" alt="verified-by-homebridge"></a>
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

By default, the plugin uses polling to check device status. If you want real-time device updates, you can optionally configure webhooks using a tunnel service.

### Setting Up Webhooks

1. **Set up a secure tunnel** using [ngrok](https://ngrok.com/) or [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):
   ```bash
   ngrok http --url=your-domain.ngrok-free.app 3000
   ```

2. **Update plugin configuration** in Homebridge UI:
   - Set **Server URL** to your tunnel URL (e.g., `https://your-domain.ngrok-free.app`)
   - Set **Webhook Port** to `3000`

3. **Note**: When using webhooks, you would create the SmartThings app with your tunnel URL instead of httpbin.org.

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
