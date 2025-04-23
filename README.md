
<p align="center">

<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">

</p>

# Smartthings Homebridge Plugin 

This is a smartthings plugin for Homebridge.  This requires no access to the legacy smartthings app, and doesn't
require a lot of work to install.  It will discover devices automatically as well as unregister devices that are removed
from your smarttthings network.  This is currently under development.

This is a fork for the homebridge-smartthings plugin created by [@iklein99](https://github.com/iklein99/), which adds oauth support and access token refresh.

# Getting Started
- The [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli#readme) installed
- [ngrok](https://ngrok.com/) or similar tool to create a secure tunnel to a publicly available URL

## Instructions

### 1. Set up your server

Start ngrok or similar tool to create a secure tunnel to your local server. Note that the free version of ngrok will
change the subdomain part of the URL every time you restart it. 
Alternately, you can use the paid version which supports reserved subdomains, or any other tool such as cloudflare zero trust tunnels which has a free tier:
```
ngrok http 3000
```
### 2. Register your SmartThings app

Look at the log output of your local server, You should see something like this:
```
Target URL -- Copy this value into the targetUrl field of you app creation request:
https://315e5367357f.ngrok.app

Redirect URI -- Copy this value into redirectUris field of your app creation request:
https://315e5367357f.ngrok.app/oauth/callback

Website URL -- Visit this URL in your browser to log into SmartThings and connect your account:
https://315e5367357f.ngrok.app
```

After Installaing the SmartThings CLI, Run the `smartthings apps:create` command to create a new smartthingsAPI app. You will be prompted for the required
information. The following is an example of the output from the command:

```bash
~ % smartthings apps:create
? What kind of app do you want to create? (Currently, only OAuth-In apps are supported.) OAuth-In App

More information on writing SmartApps can be found at
  https://developer.smartthings.com/docs/connected-services/smartapp-basics

? Display Name My API Subscription App
? Description Allows control of SmartThings devices
? Icon Image URL (optional) 
? Target URL (optional) https://315e5367357f.ngrok.app

More information on OAuth 2 Scopes can be found at:
  https://www.oauth.com/oauth2-servers/scope/

To determine which scopes you need for the application, see documentation for the individual endpoints you will use in your app:
  https://developer.smartthings.com/docs/api/public/

? Select Scopes. r:devices:*, x:devices:*, r:locations:*
? Add or edit Redirect URIs. Add Redirect URI.
? Redirect URI (? for help) https://315e5367357f.ngrok.app/oauth/callback
? Add or edit Redirect URIs. Finish editing Redirect URIs.
? Choose an action. Finish and create OAuth-In SmartApp.
Basic App Data:
─────────────────────────────────────────────────────────────────────────────
 Display Name     My API Subscription App                                    
 App Id           3275eef3-xxxx-xxxx-xxxx-xxxxxxxxxxxx                       
 App Name         amyapisubscriptionapp-aaea18b1-xxxx-xxxx-xxxx-xxxxxxxxxxxx 
 Description      Allows control of SmartThings devices                      
 Single Instance  true                                                       
 Classifications  CONNECTED_SERVICE                                          
 App Type         API_ONLY                                                   
 Target URL       https://315e5367357f.ngrok.app                             
 Target Status    PENDING                                                    
─────────────────────────────────────────────────────────────────────────────


OAuth Info (you will not be able to see the OAuth info again so please save it now!):
───────────────────────────────────────────────────────────
 OAuth Client Id      7a850484-xxxx-xxxx-xxxx-xxxxxxxxxxxx 
 OAuth Client Secret  3581f317-xxxx-xxxx-xxxx-xxxxxxxxxxxx 
───────────────────────────────────────────────────────────
```

Save the output of the create command for later use. It contains the client ID and secret of your app. You
won't be able to see those values again.

### 3. install the plugin

Download the plugin files in your homebridge machine, once downloaded Use your favorite terminal to install the plugin, you need to be inside the project folder and run the following command, Starting by installing the plugin:
```
npm install -g
```
once installed, you can build the plugin:
```
npm run build
```
after building, link the plugin to homebridge:
```
npm link homebridge-smartthings@1.5.22
```

### 4. Configure the plugin
After installing the plugin, you can configure the plugin from homebridge ui, you need the target url from step 1, and you need to add the client id and secret from the app you created in step 2.

### 5. Authorize the plugin
Once you have configured the plugin, you can authorize the plugin by clicking the authorize link found in the plugin log, after authorization proceed to restart homebridge.


