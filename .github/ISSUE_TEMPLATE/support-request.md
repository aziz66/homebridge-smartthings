---
name: Support Request
about: Need help?
title: ''
labels: question
assignees: ''

---

<!-- You must use the issue template below when submitting a support request -->

**Describe Your Problem:**
<!-- A clear and concise description of what problem you are trying to solve. -->

**Logs:**

```
Show the Homebridge logs here (ideally with Homebridge debug mode on). Remove tokens and other secrets.
```

**Plugin Config:**

> [!WARNING]
> **Redact secrets before pasting.** Replace the values of these fields with `"REDACTED"`:
> - `client_secret`
> - `oauth_access_token`
> - `oauth_refresh_token`
> - `token` inside every `frameTvDevices[]` entry
> - any other token, password or API key (also check the logs above for `Bearer` headers or tokens)
>
> Leaked tokens can give access to your SmartThings devices. If you posted one by mistake, edit it out and re-run the OAuth wizard to obtain new tokens (and regenerate the client secret with `smartthings apps:oauth:generate` if it was exposed).

```json
Show the SmartThings platform block from your Homebridge config.json here, with the fields above redacted.
```

**Screenshots:**
<!-- If applicable, add screenshots to help explain your problem. -->

**Environment:**

* **Plugin Version**:
* **Homebridge Version**: <!-- homebridge -V -->
* **Node.js Version**: <!-- node -v -->
* **NPM Version**: <!-- npm -v -->
* **Operating System**: <!-- Raspbian / Ubuntu / Debian / Windows / macOS / Docker / hb-service -->

<!-- Click the "Preview" tab before you submit to ensure the formatting is correct. -->
