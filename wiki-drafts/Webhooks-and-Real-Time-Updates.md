# Webhooks and Real-Time Updates

By default, the plugin polls SmartThings every few seconds for device state. If you want **real-time updates**, you can configure webhooks so SmartThings pushes events directly to the plugin the instant a device changes state. Polling continues to run alongside webhooks as a fallback — they are purely additive.

## How it works

When configured, the plugin:

1. Starts a webhook server on the configured port (default `3000`).
2. Registers broad capability subscriptions with SmartThings so it receives device events in real time.
3. Continues polling as normal — webhooks are additive, not a replacement.

## Prerequisites

- A **publicly accessible URL** that SmartThings can reach (via a tunnel service or port forwarding).
- A SmartThings app registered as a **Webhook SmartApp** with the correct Target URL.

---

## Setting up webhooks

### 1. Set up a secure tunnel

Use [ngrok](https://ngrok.com/), [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), or any reverse proxy to expose your Homebridge instance:

```bash
ngrok http --url=your-domain.ngrok-free.app 3000
```

Your public URL will look like `https://your-domain.ngrok-free.app`.

### 2. Create the SmartThings app with your webhook URL

When creating your SmartThings app (see [Installation and OAuth Setup](https://github.com/aziz66/homebridge-smartthings/wiki/Installation-and-OAuth-Setup) Step 2), substitute your tunnel URL for `httpbin.org`:

| Prompt | What to enter |
|---|---|
| **Target URL** | `https://your-domain.ngrok-free.app` (your public URL — this is where SmartThings sends device events) |
| **Redirect URI** | `https://your-domain.ngrok-free.app/oauth/callback` (this is the OAuth callback endpoint) |

> **Important**: The **Redirect URI** must include the `/oauth/callback` path — that's the endpoint the plugin uses to complete OAuth. The **Target URL** should be the base URL with no path; SmartThings POSTs lifecycle events (PING, EVENT, etc.) to this root URL.

If you already created the app with `httpbin.org`, update it via:

```bash
smartthings apps:update <app-id>
```

### 3. Update plugin configuration

In the Homebridge UI plugin settings:

- Set **Server URL** to your tunnel URL (e.g., `https://your-domain.ngrok-free.app`).
- Set **Webhook Port** to `3000` (or whichever port your tunnel forwards to).

### 4. Restart Homebridge

After saving, restart Homebridge. Look for these messages in the logs:

- `Webhook server listening on port 3000` — the server started.
- `Successfully flushed existing subscriptions` — old subscriptions cleared.
- `Creating X broad CAPABILITY subscriptions...` — real-time subscriptions being set up.
- `SmartThings real-time subscriptions set up successfully.` — done.

---

## URL reference

| URL | Purpose |
|---|---|
| `https://your-domain.ngrok-free.app` | **Target URL** in SmartThings app settings. SmartThings sends lifecycle events (PING, CONFIRMATION, EVENT) here. |
| `https://your-domain.ngrok-free.app/oauth/callback` | **Redirect URI** in SmartThings app settings. Used during OAuth authorization to receive the auth code. |

## Plugin configuration fields

After creating your SmartThings app and setting up the tunnel, fill in these fields in the Homebridge plugin settings:

| Field | Example | Description |
|---|---|---|
| **Client ID** | `7a850484-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | The OAuth Client ID from the `smartthings apps:create` output. |
| **Client Secret** | `3581f317-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | The OAuth Client Secret from the same output. Save this — you can't retrieve it later. |
| **Server URL** | `https://your-domain.ngrok-free.app` | Your public tunnel URL (the root, no trailing path). This tells the plugin to start the webhook server and register subscriptions. Leave empty if you only want polling. |
| **Webhook Port** | `3000` | The local port the webhook server listens on. Must match what your tunnel forwards to. Default is `3000`. |

> **Note**: The **Server URL** is the same root URL you used as the **Target URL** when creating the SmartThings app. The plugin uses it both to start the local webhook server and to build the OAuth callback endpoint (`/oauth/callback`).

---

## Managing real-time subscriptions

Once webhooks are working, you can control which capabilities get real-time subscriptions (max 20) from the Homebridge UI — no restart required.

1. Open plugin settings in the Homebridge UI.
2. Below the OAuth wizard button, you'll see the **Real-Time Subscription Manager** card.
3. The card shows all capabilities discovered from your devices, sorted by device count.
4. Check the capabilities you want subscribed in real time (up to 20).
5. Click **Save & Apply Subscriptions** to flush the old subscriptions and create new ones immediately.

**Tips:**

- Leave all unchecked to use automatic prioritization (most devices first).
- Use **Auto (by device count)** to quickly select the top 20.
- The capability list refreshes each time Homebridge restarts and discovers devices.
- Changes take effect immediately — no plugin restart needed.

---

## Troubleshooting webhooks

**"SmartThings subscriptions will not be set up"**

- This means the plugin couldn't discover the `installedAppId`. Make sure your SmartThings app is installed to your location.
- If you see a 403 error, your OAuth token may not have sufficient scopes. Re-authorize through the wizard.

**"Webhook server listening but no events arriving"**

- Verify your tunnel is working by visiting your public URL in a browser.
- Check that the Target URL in your SmartThings app settings matches your tunnel URL exactly.
- SmartThings will send a PING challenge first — check logs for `Received SmartThings PING challenge`.

**Events are working but some devices don't update in real time**

- SmartThings limits subscriptions to 20 per app. If you have more than 20 unique capabilities, lower-priority ones will remain polling-only. Check the logs for details on which capabilities are subscribed.

For broader troubleshooting, see [Troubleshooting](https://github.com/aziz66/homebridge-smartthings/wiki/Troubleshooting).
