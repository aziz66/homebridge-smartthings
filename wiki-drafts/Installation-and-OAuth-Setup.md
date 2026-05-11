# Installation and OAuth Setup

This guide walks you through installing the plugin and connecting it to your SmartThings account using the built-in OAuth wizard. The wizard handles the entire flow — no public tunnel or webhook server is required for basic polling-based operation.

## Prerequisites

- **Homebridge** with UI access (typically at `http://localhost:8581`).
- **SmartThings CLI** — [download and install](https://github.com/SmartThingsCommunity/smartthings-cli#readme) the official CLI.

---

## Step 1 — Install the plugin

1. Open the Homebridge web interface (usually `http://localhost:8581`).
2. Go to the **Plugins** tab.
3. Search for `Homebridge Smartthings oAuth Plugin`.
4. Click **Install**.

---

## Step 2 — Create the SmartThings OAuth app

You need to create a SmartThings OAuth application using the SmartThings CLI. This is a one-time setup.

1. Open a terminal and run:
   ```bash
   smartthings apps:create
   ```

2. Follow the prompts:

   | Prompt | What to enter |
   |---|---|
   | **App Type** | Select `OAuth-In App` |
   | **Display Name** | `Homebridge SmartThings` (any name you like) |
   | **Description** | `Homebridge integration` |
   | **Icon Image URL** | Press Enter to skip |
   | **Target URL** | `https://httpbin.org/get` |
   | **Scopes** | Select `r:devices:*`, `x:devices:*`, `r:locations:*` |
   | **Redirect URI** | `https://httpbin.org/get` |

   > **Important**: Use `https://httpbin.org/get` for both Target URL and Redirect URI. This is what makes the wizard work without needing a tunnel.

3. **Save your credentials immediately!** After creation you'll see:

   ```
   OAuth Info (you will not be able to see the OAuth info again so please save it now!):
   ───────────────────────────────────────────────────────────
    OAuth Client Id      7a850484-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    OAuth Client Secret  3581f317-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ───────────────────────────────────────────────────────────
   ```

   Copy both values somewhere safe. **You cannot retrieve them later.**

---

## Step 3 — Open the OAuth Setup Wizard

1. In the Homebridge UI, go to **Plugins** and find **Homebridge Smartthings oAuth Plugin**.
2. Click the **Settings** (gear icon).
3. Click **Open OAuth Setup Wizard**.

---

## Step 4 — Run through the wizard

The wizard has four steps.

### Wizard step 1 — Enter SmartThings app credentials

- Paste the **OAuth Client ID** and **OAuth Client Secret** from Step 2.
- Click **Next**.

### Wizard step 2 — Sign in to SmartThings

- Click **Next** — a new browser tab opens at the SmartThings login page.
- Sign in with your Samsung/SmartThings account.
- Select the **location** you want to use.
- Click **Authorize**.

### Wizard step 3 — Copy the authorization code

After authorizing, you'll be redirected to **httpbin.org** which displays JSON like this:

```json
{
  "args": {
    "code": "hkp89A"
  },
  "headers": { "...": "..." },
  "origin": "xxx.xxx.xxx.xxx",
  "url": "https://httpbin.org/get?code=hkp89A"
}
```

1. Find the `"code"` value in the `"args"` block (e.g. `hkp89A`).
2. Copy **only the code value** — no quotes.
3. Paste it into the wizard's **Authorization Code** field.
4. Click **Next**.

### Wizard step 4 — Save configuration

- The wizard exchanges your code for access tokens automatically.
- You'll see the **Access Token** and **Refresh Token** fields populated.
- Click **Save Configuration**.

---

## Step 5 — Restart Homebridge

1. Go to the Homebridge main page.
2. Click **Restart Homebridge**.
3. Wait for restart — your SmartThings devices should appear in HomeKit.

---

## You're done

The plugin will now:

- Discover all compatible devices automatically.
- Add them to HomeKit.
- Remove devices that are no longer in your SmartThings network.
- Refresh access tokens on its own — no manual intervention needed.

## Re-running the wizard

If tokens expire, you change SmartThings accounts, or anything else goes wrong with auth:

1. Open plugin settings.
2. Click **Open OAuth Setup Wizard**.
3. Complete all steps again.
4. Restart Homebridge.

## Next steps

- **Want real-time device updates?** See [Webhooks and Real-Time Updates](https://github.com/aziz66/homebridge-smartthings/wiki/Webhooks-and-Real-Time-Updates).
- **Have a Samsung Frame TV?** See [Samsung Frame TV](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV).
- **Run into a problem?** See [Troubleshooting](https://github.com/aziz66/homebridge-smartthings/wiki/Troubleshooting).
