# Troubleshooting

Common issues and how to fix them. If your problem isn't listed here, [open an issue on GitHub](https://github.com/aziz66/homebridge-smartthings/issues) with your Homebridge logs.

---

## Setup & OAuth

**"I don't see the OAuth wizard button"**

- Make sure you have the latest version of the plugin (1.0.34+).
- Try clearing your browser cache and refreshing the Homebridge UI.

**"Authorization code is invalid"**

- Make sure you copied **only the code value**, not the entire JSON.
- The code expires quickly — try the authorization process again.
- Ensure you're copying from `args.code`, not from the URL.

**"Plugin not finding devices after setup"**

- Verify your SmartThings app has the correct scopes: `r:devices:*`, `x:devices:*`, `r:locations:*`.
- Make sure you selected the correct location during authorization.
- Restart Homebridge after completing the wizard.

**"Devices not responding"**

- Restart Homebridge.
- Check that devices are online in the SmartThings app.
- Check the Homebridge logs for error messages.

---

## Re-running the wizard

If you need to re-authenticate (tokens expired, changed SmartThings account, etc.):

1. Go to plugin settings.
2. Click **Open OAuth Setup Wizard**.
3. Complete all steps again.
4. Restart Homebridge.

---

## Webhooks

**"SmartThings subscriptions will not be set up"**

- The plugin couldn't discover the `installedAppId`. Make sure your SmartThings app is installed to your location.
- If you see a 403 error, your OAuth token may not have sufficient scopes. Re-authorize through the wizard.

**"Webhook server listening but no events arriving"**

- Verify your tunnel is working by visiting your public URL in a browser.
- Check that the Target URL in your SmartThings app settings matches your tunnel URL exactly.
- SmartThings will send a PING challenge first — check logs for `Received SmartThings PING challenge`.

**Events are working but some devices don't update in real time**

- SmartThings limits subscriptions to 20 per app. If you have more than 20 unique capabilities, lower-priority ones will remain polling-only. Check the logs for which capabilities are subscribed.

For full webhook setup, see [Webhooks and Real-Time Updates](https://github.com/aziz66/homebridge-smartthings/wiki/Webhooks-and-Real-Time-Updates).

---

## Samsung Frame TV

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

**"Allow" popup didn't appear during pairing**

- Make sure the TV is **on** when Homebridge starts.
- If you accidentally clicked "Deny", the TV remembers the denial. Reset it: **Settings → General → External Device Manager → Device Connection Manager → Device List**, find "Homebridge SmartThings" and either change permission to **Allow** or remove the entry.

For full Frame TV setup, see [Samsung Frame TV](https://github.com/aziz66/homebridge-smartthings/wiki/Samsung-Frame-TV).

---

## Samsung Family Hub refrigerators

**Compartment temperatures show "No Response" in HomeKit**

- Make sure `ExposeMultiZoneRefrigerator` is enabled in plugin settings.
- The plugin parses Samsung's OCF data, which is region-specific. Tested against US-region firmware (RF29DB9600QLA). Metric-region devices may report Celsius differently — please open an issue with your model number and a sample of the device status JSON if temperatures look wrong.

**Disabled compartments still appear as tiles**

- Confirm the compartment is actually disabled in the SmartThings app (not just hidden).
- The disabled-compartment list is fetched once at startup. If you change which compartments are disabled, restart Homebridge for the change to take effect.

---

## Getting help

If you've tried the above and still have a problem:

1. Check the Homebridge logs for detailed error messages.
2. Ensure all credentials are correct.
3. Try re-running the OAuth wizard.
4. [Open an issue on GitHub](https://github.com/aziz66/homebridge-smartthings/issues) with:
   - Your plugin version (`npm list -g homebridge-smartthings-oauth`).
   - Homebridge version.
   - Relevant log lines (please redact tokens and credentials).
   - The SmartThings device(s) involved (model and capabilities, if relevant).
