
<p align="center">

<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">  [![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

</p>

# SmartThings Homebridge Plugin with OAuth Support

A modern SmartThings plugin for Homebridge that provides seamless integration with your SmartThings devices. This plugin features automatic device discovery, OAuth authentication, and access token refresh capabilities.

## ✨ Features

- **No Legacy App Required**: Works with the new SmartThings app and API
- **Automatic Device Discovery**: Automatically finds and adds your SmartThings devices
- **Device Management**: Automatically removes devices that are no longer in your SmartThings network
- **OAuth Support**: Secure authentication with automatic token refresh
- **Easy Setup**: Simplified installation and configuration process

## 📋 Prerequisites

Before you begin, ensure you have the following installed and configured:

- **Homebridge**: A working Homebridge installation
- **SmartThings CLI**: [Download and install](https://github.com/SmartThingsCommunity/smartthings-cli#readme) the official SmartThings CLI tool
- **Tunneling Service**: One of the following:
  - [ngrok](https://ngrok.com/) (free tier available)
  - [Cloudflare Zero Trust Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (free)
  - Any other secure tunnel service

## 🚀 Installation Guide

### Step 1: Set Up Secure Tunnel

You need a secure tunnel to expose your local Homebridge server to the internet for SmartThings OAuth callbacks.

#### Option A: Using ngrok (Recommended for beginners)

1. **Sign up and get your domain**:
   - Create a free account at [ngrok.com](https://ngrok.com/)
   - Go to your ngrok dashboard and note your free domain (e.g., `your-domain.ngrok-free.app`)

2. **Start the tunnel**:
   ```bash
   ngrok http --url=your-domain.ngrok-free.app 3000
   ```
   > **Important**: Replace `your-domain.ngrok-free.app` with your actual ngrok domain. Keep port `3000` as shown.

#### Option B: Using Cloudflare Zero Trust Tunnels (Free alternative)

Follow the [Cloudflare tunnel setup guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to create a tunnel pointing to `localhost:3000`.

### Step 2: Create SmartThings App

> **⚠️ Important**: You must create the SmartThings app FIRST to get the Client ID and Secret needed for plugin configuration.

1. **Run the app creation command**:
   ```bash
   smartthings apps:create
   ```

2. **Follow the prompts carefully**:

   | Prompt | Your Answer | Example |
   |--------|-------------|---------|
   | **App Type** | `OAuth-In App` | OAuth-In App |
   | **Display Name** | Choose a descriptive name | `Homebridge SmartThings` |
   | **Description** | Brief description | `Homebridge integration for SmartThings devices` |
   | **Icon Image URL** | Leave blank | _(press Enter)_ |
   | **Target URL** | Your tunnel URL | `https://your-domain.ngrok-free.app` |
   | **Scopes** | Required permissions | `r:devices:*`, `x:devices:*`, `r:locations:*` |
   | **🔴 Redirect URI** | **CRITICAL: Your callback URL** | `https://your-domain.ngrok-free.app/oauth/callback` |

   > **🚨 CRITICAL**: The **Redirect URI** must be exactly `https://your-domain.ngrok-free.app/oauth/callback` (including `/oauth/callback`). This is essential for OAuth to work properly!

3. **Save your credentials immediately**:
   
   After creation, you'll see output like this:
   ```
   OAuth Info (you will not be able to see the OAuth info again so please save it now!):
   ───────────────────────────────────────────────────────────
    OAuth Client Id      7a850484-xxxx-xxxx-xxxx-xxxxxxxxxxxx 
    OAuth Client Secret  3581f317-xxxx-xxxx-xxxx-xxxxxxxxxxxx 
   ───────────────────────────────────────────────────────────
   ```

   > **⚠️ Critical**: Copy and save both the **Client ID** and **Client Secret** immediately. You cannot retrieve them later!

### Step 3: Install the Plugin

Now that you have your SmartThings app credentials, you can install and configure the plugin.

1. **Install via Homebridge UI**:
   - Open your Homebridge web interface
   - Go to the "Plugins" tab
   - Search for `Homebridge Smartthings oAuth Plugin`
   - Click "Install"

### Step 4: Configure the Plugin

1. **Open Homebridge Configuration**:
   - Go to your Homebridge web interface
   - Navigate to "Plugins" tab
   - Find "SmartThings OAuth Plugin" and click "Settings"

2. **Enter your configuration** (using credentials from Step 2):
   
   | Field | Value | Notes |
   |-------|-------|-------|
   | **Target URL** | `https://your-domain.ngrok-free.app` | Your tunnel URL (without `/oauth/callback`) |
   | **Client ID** | Your OAuth Client ID | From Step 2 |
   | **Client Secret** | Your OAuth Client Secret | From Step 2 |

   > **📝 Note**: The plugin automatically appends `/oauth/callback` to your Target URL, so don't include it.

3. **Save the configuration**.

### Step 5: Authorize the Plugin

1. **Restart Homebridge** to apply the configuration.

2. **Check the logs** for an authorization URL:
   ```
   [SmartThings OAuth] Visit this URL to authorize the plugin:
   https://your-domain.ngrok-free.app/authorize?client_id=...
   ```

3. **Authorize the plugin**:
   - Copy the complete authorization URL from the logs
   - Paste it into your web browser
   - Log in to your SmartThings account
   - Grant the requested permissions
   - You should see a success message

4. **Final restart**: Restart Homebridge one more time to complete the setup.

## 🎉 You're Done!

Your SmartThings devices should now appear in HomeKit! The plugin will automatically:
- Discover all compatible devices
- Add them to HomeKit
- Remove devices that are no longer available
- Refresh access tokens as needed

## 🔧 Troubleshooting

### Common Issues

**Plugin not finding devices**:
- Verify your SmartThings app has the correct scopes: `r:devices:*`, `x:devices:*`, `r:locations:*`
- Check that your tunnel is still running
- Ensure you completed the authorization step

**Authorization fails**:
- Make sure you copied the complete authorization URL
- Verify your tunnel URL is accessible from the internet
- Check that your Client ID and Secret are correct

**Devices not responding**:
- Restart Homebridge
- Check that devices are online in the SmartThings app
- Verify the plugin has the necessary permissions

### Getting Help

If you encounter issues:
1. Check the Homebridge logs for detailed error messages
2. Ensure all URLs and credentials are correct
3. Verify your tunnel service is running properly

## 📄 Credits

This is a fork of the original homebridge-smartthings plugin created by [@iklein99](https://github.com/iklein99/), enhanced with OAuth support and automatic token refresh capabilities.