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

### 5. Confirm the Target URL — **required, or no events will arrive**

When you create the app, its Target URL starts in a **`PENDING`** state. SmartThings only delivers device events once the Target URL is **`CONFIRMED`** — and **OAuth authorization does not confirm it.** You must trigger the confirmation once, **while Homebridge is running** (so the plugin's webhook server is up to answer the request):

```bash
smartthings apps:register <your-app-id>
```

This tells SmartThings to POST a CONFIRMATION request to your Target URL; the plugin receives it and confirms automatically. Then verify:

```bash
smartthings apps <your-app-id> -j
```

Look for `targetStatus: "CONFIRMED"` under `apiOnly.subscription`:

```json
"apiOnly": {
  "subscription": {
    "targetUrl": "https://your-domain.ngrok-free.app",
    "targetStatus": "CONFIRMED"
  }
}
```

> **This is the single most common reason real-time updates silently don't work.** If OAuth succeeded, devices were discovered, and subscriptions were created — but no events ever arrive — your Target URL is almost certainly still `PENDING`. Run `apps:register` (with Homebridge running) and it will flip to `CONFIRMED`. Note: you can only register a `PENDING` app; re-running `apps:register` on an already-`CONFIRMED` app returns a `422` error, which is harmless and just means it's already confirmed.

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

## Verifying webhook signatures

By default the plugin processes any POST that reaches your Target URL. Because that URL is public, anyone who discovers it could send forged device events. SmartThings actually **signs every webhook request** (an RSA-SHA256 HTTP Signature over the request body), and the optional **`verifyWebhookSignatures`** setting makes the plugin verify that signature and reject anything that fails.

When enabled, each inbound POST must have:

- a valid SmartThings signature (verified against SmartThings' published certificate),
- a body digest that matches the signed value, and
- a timestamp within ±15 minutes (replay protection).

Requests that fail are rejected with **HTTP 401** before any processing; unrecognized request types are dropped with **HTTP 400**. Legitimate SmartThings traffic is unaffected.

### Enabling it safely

> ℹ️ Verification also covers the `CONFIRMATION` handshake — and SmartThings signs that request too, so turning this on does **not** block registration (confirmed in live testing). As good practice, get real-time updates working first, then enable verification, so it's easy to confirm events keep flowing.

1. Make sure your **Server URL is `https`**. Verification requires it — with a plain `http` URL the plugin logs a warning and leaves verification **disabled** (it does not break your webhook).
2. Ideally confirm real-time updates already work (see [Step 5](#5-confirm-the-target-url--required-or-no-events-will-arrive)), so you have a known-good baseline.
3. Enable **Verify SmartThings Webhook Signatures** in the plugin settings and restart.
4. Watch the logs: you should see events continue to flow. If you instead see `Rejected webhook POST on / - HTTP signature verification failed (401)`, see the troubleshooting note below.

**Polling still runs regardless**, so even in the worst case (verification wrongly rejecting events) your devices keep updating via polling — you won't lose state, only the real-time push.

For polling-only setups (no Server URL), this setting does nothing — the webhook server never starts.

---

## Troubleshooting webhooks

**"SmartThings subscriptions will not be set up"**

- This means the plugin couldn't discover the `installedAppId`. Make sure your SmartThings app is installed to your location.
- If you see a 403 error, your OAuth token may not have sufficient scopes. Re-authorize through the wizard.

**"Webhook server listening but no events arriving"**

- **First, check your Target URL is `CONFIRMED`** — this is the most common cause. Run `smartthings apps <your-app-id> -j` and look at `apiOnly.subscription.targetStatus`. If it's `PENDING`, run `smartthings apps:register <your-app-id>` with Homebridge running (see [Step 5](#5-confirm-the-target-url--required-or-no-events-will-arrive)). Auth succeeding and subscriptions being created does **not** mean the target is confirmed.
- Verify your tunnel is working by visiting your public URL in a browser.
- Check that the Target URL is your tunnel **root** (no path) — the plugin only accepts events at `/`; a Target URL with a path (e.g. ending in `/oauth/callback`) will not receive events.
- **Cloudflare Tunnel users — add a WAF skip rule (confirmed gotcha).** Cloudflare's WAF / Bot Fight Mode can **silently drop** SmartThings' server-to-server event POSTs. This is especially sneaky because Cloudflare's Security → Events log only shows *blocked/challenged* requests — a silently-dropped POST appears **nowhere**, so an empty firewall log does **not** mean the request arrived. If your target is `CONFIRMED` and subscriptions exist but no events arrive on a Cloudflare Tunnel:
  - **Isolate it:** temporarily point your Target URL at an **ngrok** URL instead and `smartthings apps:register <app-id>` to re-confirm. If events flow over ngrok, Cloudflare is the culprit.
  - **Fix:** in the Cloudflare dashboard, create a **WAF custom rule** that **skips all WAF checks** for SmartThings' event-delivery IP range — `18.221.0.0/16` (AWS `us-east-2`, where SmartThings runs event delivery). With that in place, events flow through the Cloudflare Tunnel just as reliably as ngrok.
- For any tunnel provider with bot/WAF protection, make sure it isn't dropping SmartThings' POSTs (no browser headers — easily flagged as bot traffic).
- SmartThings will send a PING challenge first — check logs for `Received SmartThings PING challenge`.

**Real-time updates stopped right after enabling `verifyWebhookSignatures`**

- Check the logs for `Rejected webhook POST on / - HTTP signature verification failed (401)`. If present, verification is rejecting requests.
- Confirm your **Server URL is `https`**. With a non-https URL the plugin logs `verifyWebhookSignatures is enabled but Server URL is not https` and disables verification — so this isn't the cause, but it means the feature isn't actually protecting you.
- If the host clock is wrong, the ±15-minute freshness check can reject valid events (`Date header outside 15-minute window`). Fix time sync (NTP) on the Homebridge host.
- As a quick recovery, set `verifyWebhookSignatures` back to `false`; polling keeps devices updated while you investigate.

**Events are working but some devices don't update in real time**

- SmartThings limits subscriptions to 20 per app. If you have more than 20 unique capabilities, lower-priority ones will remain polling-only. Check the logs for details on which capabilities are subscribed.

For broader troubleshooting, see [Troubleshooting](https://github.com/aziz66/homebridge-smartthings/wiki/Troubleshooting).
