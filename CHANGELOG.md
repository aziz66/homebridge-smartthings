# Changelog
All notable changes to this project will be documented in this file.

## [1.0.44] - Samsung Frame TV, TV App Launcher & Washer Service

### Added
- **Samsung Frame TV Full Power Off**: Frame TVs now support true power off via a 3.5-second long-press of KEY_POWER sent over local WebSocket. The standard SmartThings `switch.off` command only puts Frame TVs into Art Mode — this bypasses that behavior entirely.
- **Art Mode Switch**: A separate HomeKit switch to toggle Art Mode on and off for each configured Frame TV. Appears as its own tile in the Home app for easy access and automation.
- **Local WebSocket Connection Manager** (`src/local/samsungWebSocket.ts`): Handles secure WebSocket connections to Samsung TVs on port 8002 (remote control) and port 8001 (Art Mode channel). Supports lazy connect-on-demand and automatic idle disconnect after 8 seconds.
- **TV Authorization Token Flow**: First-time connections prompt an "Allow/Deny" popup on the TV. Once accepted, the token is saved automatically and reused for all future connections — no manual pairing code needed.
- **Frame TV Configuration UI**: New "Samsung Frame TV Settings" section in the Homebridge UI to add/remove Frame TV devices with IP address, full power off toggle, and Art Mode toggle.
- **Frame TV Auto-Detection**: The plugin automatically detects Frame TVs by checking the `artSupported` field from SmartThings device status. A helpful log message is shown during startup if a Frame TV is found but not yet configured, guiding users to add the TV's local IP address.
- **`frameTvDevices` config field**: New array in `config.schema.json` for configuring Frame TV devices with `deviceName`, `ip`, `enableFullPowerOff`, `enableArtModeSwitch`, and optional `token` fields.
- **TV App Shortcuts**: Launch Samsung TV apps (Netflix, YouTube, Disney+, etc.) directly from the HomeKit TV input picker. Apps appear as additional input sources (type APPLICATION) alongside HDMI inputs. Select which apps to enable from the "TV App Shortcuts" card in the Homebridge UI. Uses `custom.launchapp` capability — no apps enabled by default.
- **TV App Shortcuts UI**: New "TV App Shortcuts" card in the Homebridge UI with a checkbox list of 18 predefined Samsung TV apps. Only selected apps appear in the HomeKit input picker.
- **`tvApps` config field**: New array in `config.schema.json` for selecting TV app shortcuts by app ID (default: empty).
- **Washer Service**: New service mapping `washerOperatingState` capability to a HomeKit Valve with Active, InUse, and RemainingDuration countdown for Samsung washers.
- **README section**: Added documentation covering Frame TV auto-detection, configuration options, first-time pairing, troubleshooting, and how to recover from an accidental "Deny" on the TV popup.

### Changed
- **TelevisionService**: When a Frame TV is configured, power off is intercepted and routed through the local WebSocket instead of the SmartThings API. Power on continues to use the SmartThings API as normal. On WebSocket failure, falls back to SmartThings API with a warning log.
- **MultiServiceAccessory**: Detects Frame TV devices by matching the SmartThings device name against `frameTvDevices` config entries (case-insensitive). Creates a shared `SamsungWebSocket` instance used by both the TV service and Art Mode switch.
- **Platform**: Registers Art Mode accessories as separate platform accessories after device discovery, with UUIDs derived from `deviceId + '-artmode'` to ensure uniqueness.

### Fixed
- **Art Mode Accessory Registration**: Fixed incorrect `PLUGIN_NAME` (`homebridge-smartthings-ik` instead of `homebridge-smartthings-oauth`) which prevented the Art Mode switch from appearing in HomeKit.
- **Art Mode Accessory Persistence**: Fixed a bug where the Art Mode accessory was unregistered and re-registered on every restart because its derived UUID didn't match any SmartThings device ID. Art Mode accessories are now excluded from the cleanup loop.

### Security
- **Dependency audit**: Fixed all 6 npm audit vulnerabilities (axios, form-data, glob, js-yaml, brace-expansion, diff) — 0 vulnerabilities remaining.

### Dependencies
- Added `ws` (^8.0.0) and `@types/ws` (^8.0.0) for local WebSocket communication with Samsung TVs.

## [1.0.43] - Real-Time Subscription Manager UI
### Added
- **Capability Subscription Selector**: New UI card in Homebridge settings to manually choose which capabilities get real-time SmartThings subscriptions (max 20). Available for users with webhooks configured.
  - Checkbox list of all discovered capabilities sorted by device count
  - Counter badge showing selected / 20 limit
  - "Clear All" and "Auto (by device count)" quick-select buttons
  - "Save & Apply Subscriptions" flushes and recreates subscriptions immediately without restarting the plugin
  - "Refresh List" to reload discovered capabilities
- **`selectedCapabilities` config field**: Optional array in config.schema.json to persist manual capability selections across restarts. Leave empty for automatic prioritization (existing behavior).
- **`available_capabilities.json`**: Plugin now writes discovered capabilities and device counts to Homebridge storage after device discovery, enabling the UI to display them.
- **Server endpoints**: `/capabilities` (read discovered list) and `/resubscribe` (flush + create subscriptions via SmartThings API) added to the UI server.

### Fixed
- **Security (XSS)**: Replaced all `innerHTML` string concatenation in the capability selector with safe `createElement`/`textContent` DOM building
- **Security (Input Validation)**: `/resubscribe` endpoint now validates capability names against the discovered list before sending to SmartThings API
- **Reliability**: `writeAvailableCapabilities` now uses async `fs.promises.writeFile` with atomic temp+rename instead of blocking `writeFileSync`
- **Error Handling**: Added JSON schema validation for `available_capabilities.json` and `smartthings_tokens.json` reads in server endpoints
- **Error Handling**: Plugin now logs a clear warning and falls back to automatic prioritization when all user-selected capabilities are invalid
- **UX**: "Save & Apply" button disables during the request to prevent duplicate flush+create cycles
- **UX**: Improved error messages in capability list loading with actionable guidance

## [1.0.42] - OAuth Wizard UI Fix
### Fixed
- **OAuth Wizard Flashing/Disappearing**: Fixed issue where the OAuth setup wizard would briefly flash and then disappear. This was caused by the `configChanged` event triggering `updateUi()` which would hide the wizard. Added state tracking to prevent the wizard from being closed when intentionally opened.

## [1.0.41] - Documentation Update
### Changed
- Updated CHANGELOG.md with entries for versions 1.0.37-1.0.40

## [1.0.40] - Pagination & Whitelist Support
### Fixed
- **200 Device Limit**: Fixed pagination issue where only the first 200 devices were fetched from SmartThings API. The plugin now follows `_links.next` to fetch all devices regardless of total count.
- **OAuth Token Refresh Bug**: Fixed critical bug where refresh tokens were not being saved after refresh in `auth.initialize()` and the 401 response interceptor. This caused "invalid_grant" errors after 24 hours for users who set up via the OAuth wizard.

### Added
- **ShowOnlyDevices (Whitelist)**: New configuration option to specify only the devices you want to expose to HomeKit. This is much easier than listing hundreds of devices to ignore when you only want a few.
  - Takes precedence over `IgnoreDevices` when configured
  - Case-insensitive matching with special character normalization
  - Useful for users with many SmartThings devices who only want to expose a subset

### Changed
- **OAuth Wizard**: Now saves `expires_in` value from SmartThings for accurate token expiry tracking instead of assuming 24 hours
- **Device Discovery Logging**: Now logs total number of devices discovered after fetching all pages

## [1.0.39] - OAuth Enhancements
### Fixed
- **OAuth Wizard Token Updates**: Fixed issue where re-running the OAuth wizard wouldn't update tokens if a token file already existed. The wizard now clears the old token file before saving new configuration.

### Changed
- **Improved Token Management**: Better handling of token file vs config token precedence

## [1.0.38] - Maintenance
### Changed
- Updated local settings and configurations
- Minor internal improvements

## [1.0.37] - Repository Cleanup
### Changed
- Updated .gitignore and .npmignore to include new exclusions
- Removed .claude folder from git tracking
- Enhanced settings configuration

## [1.0.36] - Cleanup
### Fixed
- Removed unnecessary files from npm package (nul, issues/)
- Updated .gitignore and .npmignore

## [1.0.35] - Documentation Update
### Changed
- **Enhanced README**: Added detailed step-by-step wizard instructions
  - Clear explanation of httpbin.org redirect and how to copy the authorization code
  - Example JSON response showing exactly what users will see
  - Troubleshooting section for common wizard issues
  - Re-authentication instructions

## [1.0.34] - OAuth Setup Wizard - No Tunnel Required!
### Added
- **OAuth Setup Wizard**: New 4-step UI wizard for easy OAuth authentication setup
  - No tunnel (ngrok/Cloudflare) required for initial setup
  - Uses httpbin.org as redirect URL to capture authorization code
  - Guided step-by-step process in Homebridge UI
  - Automatic token exchange and storage
- **Homebridge UI Integration**: Custom UI using `@homebridge/plugin-ui-utils`
  - Beautiful wizard interface with progress indicators
  - Form validation and error handling
  - Toast notifications for success/error states
- **Token Management Improvements**:
  - Tokens can now be loaded from config (wizard flow) or token file (existing flow)
  - Seamless migration for existing users

### Changed
- **Server URL Now Optional**: No longer required for basic setup
  - Only needed if you want webhook-based real-time updates
  - Webhook server only starts when server_url is configured
- **Webhook Port Now Optional**: Defaults to 3000, only used with webhooks
- **Improved Auth Flow Messages**: Better guidance when authentication is needed
  - Points users to the UI wizard instead of requiring manual URL visits
- **Updated README**: Simplified setup instructions focusing on the new wizard

### Technical Details
- Added `@homebridge/plugin-ui-utils` and `simple-oauth2` dependencies
- Created `homebridge-ui/server.js` for OAuth token exchange endpoints
- Created `homebridge-ui/public/index.html` for wizard UI
- Updated `config.schema.json` with `customUi: true` and new token fields
- Updated `TokenManager` to support loading tokens from config
- Updated `WebhookServer` to be optional (only starts with server_url)

## [1.0.33] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **Bug Fixes**: Bug fixes
## [1.0.32] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component 
## [1.0.31] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.30] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.29] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.28] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.27] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **🚨 CRITICAL: Volume Slider Component Targeting**: Fixed volume slider targeting wrong device components (was controlling light sensor instead of TV audio)
- **Volume Slider Tile Placement**: Volume slider now appears within the same TV tile in HomeKit (not as separate accessory)
- **Direct API Calls**: Volume slider now uses direct SmartThings API calls to main TV component, ensuring reliable volume control
- **Component Confusion**: Added strict `componentId === 'main'` check to prevent volume slider creation on sensor components

### Changed
- **Volume Slider Architecture**: Simplified to work as a service within the same TV accessory (same HomeKit tile)
- **TelevisionSpeaker Conflicts**: When volume slider is enabled, TelevisionSpeaker completely disables volume controls to prevent conflicts
- **API Communication**: Volume slider bypasses internal component status and uses direct API calls for immediate responsiveness
## [1.0.26] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Bug fixes**
## [1.0.25] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Bug fixes**
## [1.0.24] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Bug fixes**
## [1.0.23] - Complete Samsung TV Experience & Reference Implementation Alignment
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control

## [1.0.21] - Samsung TV Custom Input Names & Simplified Experience
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control
  
## [1.0.20] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **🔊 Samsung TV Volume Control**: fixed audio issue with homekit

## [1.0.19] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **🔊 Samsung TV Volume Control**: fixed audio issue with homekit

## [1.0.18] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume does not apear in homekit
## [1.0.17] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control
  
## [1.0.16] - Official SmartThings API Compliance & Samsung TV Fixes
### Fixed
- **📋 Official SmartThings API Compliance**: Completely aligned implementation with official SmartThings capability specifications
  - Updated audioVolume commands to match official spec (0-100 integer values with "%" unit)
  - Fixed audioMute commands to use both setMute("muted"/"unmuted") and simple mute/unmute fallback
  - Enhanced mediaInputSource to support both Samsung-specific and standard input source commands
  - Added proper mediaPlayback support for play, pause, stop, rewind, fastForward commands
  - Implemented tvChannel support for channelUp, channelDown, and setTvChannel commands
- **🔊 Samsung TV Volume Control**: Fixed critical issue where volume commands would report success but not actually change TV volume
  - Implemented automatic unmute before setting volume when TV is muted
  - Added proper volume range validation (0-100) and integer conversion per official spec
  - Enhanced volume command logging for better debugging
  - Added delayed status refresh to verify volume changes took effect
- **🔇 Enhanced Mute Control**: Improved mute/unmute command reliability with official spec compliance
  - Primary: Uses setMute command with "muted"/"unmuted" string arguments (official spec)
  - Fallback: Uses simple mute/unmute commands for compatibility
  - Enhanced logging and status verification
- **📺 Input Source Control**: Enhanced input source switching with dual capability support
  - Primary: Samsung-specific samsungvd.mediaInputSource capability
  - Fallback: Standard mediaInputSource capability for broader compatibility
  - Better error handling and logging for failed input changes
- **🎮 Media Playback Controls**: Added full media playback support based on official mediaPlayback capability
  - Play/Pause remote key support with smart play/pause detection
  - Rewind and Fast Forward controls
  - Proper capability detection before sending commands
- **📡 Channel Controls**: Added TV channel control support based on official tvChannel capability
  - Channel Up/Down via remote control keys
  - Capability detection to ensure TV supports channel control

### Added
- **🏷️ Dynamic Input Source Names**: Samsung TV custom input names now display properly in HomeKit
  - Shows custom names like "PlayStation 5", "Apple TV" instead of generic "HDMI1", "HDMI2"
  - Automatically fetches fresh custom names from Samsung TV during device registration
  - Fallback to generic names if custom names not available
  - Focused on physical input sources only for clean, simple experience
- **🎚️ Volume Slider Accessory**: Added separate lightbulb accessory for TV volume control
  - Configurable via `registerVolumeSlider: boolean` option (default: false)
  - Volume appears as brightness slider (0-100%), mute as on/off toggle
  - Shows as separate accessory in Home app for easy volume access
- **📖 Official Capability Validation**: All commands now validate against official SmartThings capability specifications
- **🔄 Smart Command Fallbacks**: Multiple command strategies for better device compatibility
- **📊 Enhanced Logging**: Detailed logging with ✅/❌ indicators for successful/failed commands
- **⏱️ Improved Timing**: Optimized status refresh timing for better command verification

### Changed
- **🔇 Speaker State Management**: Speaker active/inactive state now properly reflects TV power and mute status
- **📱 HomeKit Integration**: Improved native TV interface experience with proper audio controls
- **🎚️ Volume Control**: Enhanced volume slider responsiveness with Samsung TV-specific unmute logic
- **🔧 Command Processing**: All commands now follow official SmartThings capability specifications
- **🎛️ Remote Control**: Remote keys now properly map to official SmartThings capabilities

### Technical Details
- Implemented official audioVolume capability (integer 0-100, setVolume command, volumeUp/volumeDown)
- Implemented official audioMute capability (setMute with "muted"/"unmuted", mute/unmute fallbacks)
- Implemented official mediaInputSource capability (setInputSource with enum values)
- Implemented official mediaPlayback capability (play, pause, stop, rewind, fastForward)
- Implemented official tvChannel capability (channelUp, channelDown, setTvChannel)
- Added capability detection before sending commands to prevent unsupported operations
- Enhanced service linking architecture following HomeKit Television service specifications
- Improved event processing for synchronized TV and speaker state updates

## [1.0.15] - Television Service Support & IgnoreDevices Bug Fixes
### Added
- **🎬 Television Service**: Samsung TVs now appear as proper Television accessories in HomeKit instead of simple switches
- **📺 Input Source Control**: Full support for HDMI inputs, TV tuner, and custom input names from SmartThings
- **🔊 Audio Controls**: Complete volume control, mute/unmute, and volume up/down buttons via TelevisionSpeaker service
- **🎨 Picture Mode Support**: Control Samsung picture modes (Standard, Dynamic, Movie, etc.) from HomeKit
- **🎮 Remote Control**: Support for media playback controls (rewind, fast forward, channel up/down)
- **🔇 TelevisionSpeaker Integration**: Proper speaker service with Active characteristic and volume bounds (0-100)
- **⚙️ Configuration Options**:
  - `enableTelevisionService` (default: true) - Enable/disable Television service for TV devices
  - `removeLegacySwitchForTV` (default: false) - Option to remove legacy switch service for TVs
  - `PollTelevisionsSeconds` (default: 15) - TV-specific polling interval

### Fixed
- **🔧 IgnoreDevices Functionality**: Fixed multiple issues that prevented the `IgnoreDevices` configuration from working properly
  - Fixed Unicode character handling for device names with smart quotes (`'`) and special characters
  - Added proper input validation to ensure `IgnoreDevices` is configured as an array of strings
  - Fixed whitespace trimming in device name comparisons
  - Added comprehensive debug logging to help troubleshoot ignore list issues
- **📖 Configuration Documentation**: Enhanced `config.schema.json` with better descriptions and examples for `IgnoreDevices`

### Changed
- **🔍 Smart TV Detection**: Automatic detection of Samsung TVs based on device capabilities
- **🏠 HomeKit Category**: TVs now appear with proper Television icon and controls in Home app
- **📊 Capability Mapping**: Enhanced capability detection to include TV-specific Samsung capabilities
- **🐛 Device Name Normalization**: Device names and ignore list entries are now properly normalized for consistent matching
- **⚠️ Error Handling**: Added warning messages for invalid `IgnoreDevices` configuration formats

### Technical Details
- Created `TelevisionService` class extending `BaseService`
- TV detection based on `samsungvd.deviceCategory`, `samsungvd.mediaInputSource`, audio capabilities, and TV channels
- Proper HomeKit Television service implementation with primary service designation
- TelevisionSpeaker service with both absolute and relative volume control support
- Speaker Active characteristic properly linked to TV power and mute states
- Volume characteristics with proper bounds (0-100) and step increments
- Maintains backward compatibility - existing Switch services continue working
- Stable UUIDs prevent service duplication across restarts
- Graceful fallback for missing TV capabilities
- Enhanced character normalization using Unicode regex patterns (`\u2018`, `\u2019`, `\u201C`, `\u201D`)
- Added debug logs showing device name comparisons: `"normalized_device_name" vs "normalized_ignore_name"`
- Improved error messages guide users to correct configuration format
- Case-insensitive matching with automatic whitespace trimming

### Migration Notes
- **Non-breaking**: Existing TV devices will automatically upgrade to Television service on next restart
- **Legacy Support**: Original switch functionality preserved by default
- **No User Action Required**: TV detection and upgrade happens automatically

## [1.0.9] - Homebridge v2.0 Compatibility
### Added
- **Homebridge v2.0 Support**: Added support for Homebridge v2.0.0-beta.0 and above
- **HAP-NodeJS v1 Compatibility**: Updated to comply with HAP-NodeJS v1 breaking changes
- **Crash Loop Recovery**: Added `handleCrashLoopRecovery()` method for improved error handling

### Changed
- **BatteryService Rename**: Renamed `BatteryService` class to `Battery` to comply with HAP-NodeJS v1 changes
- **Package.json Engines**: Updated to support both Homebridge v1.6.0+ and v2.0.0-beta.0+
- **Backward Compatibility**: Maintained full compatibility with Homebridge v1.x

### Technical Details
- Updated `package.json` engines field to `"^1.6.0 || ^2.0.0-beta.0"`
- Renamed `BatteryService` to `Battery` in `src/services/batteryService.ts`
- Updated capability map in `src/multiServiceAccessory.ts`
- Added crash loop recovery method in `src/auth/auth.ts`
- Verified existing code already complies with HAP-NodeJS v1 requirements

### Notes
- The plugin is now ready for Homebridge v2.0 testing
- All existing functionality is preserved
- No breaking changes for existing users
- Comprehensive migration documentation provided

## [1.0.8]
### Fixed
- Corrected `.npmignore` file to ensure the compiled `dist` directory is included in the published package, resolving installation failures during Homebridge verification.

## [Released]

## [1.0.7]
### Fixed
- Addressed an issue where setting the fan speed to 0% in HomeKit would incorrectly turn off the air conditioner instead of setting the fan mode to 'Auto'. Implemented a mechanism in `AirConditionerService` to correctly handle this sequence and maintain the 'Auto' fan mode.

## [1.0.6] 
### Changed
- Updated minimum required Node.js version to v20.0.0. Adjusted `engines` field in `package.json` accordingly.
- Tested compatibility with Node.js v20.

## [1.0.5]
### Changed
- Corrected and updated CHANGELOG.md details for version 1.0.4.

## [1.0.4]
### Added
- Support for selecting "Speed and Windfree" under "Optional Mode For Air Conditioners" in the configuration. This option exposes separate HomeKit switches for the Speed and WindFree modes.
- Added descriptive text and a link to setup instructions ([README](https://github.com/aziz66/homebridge-smartthings?tab=readme-ov-file#instructions)) for the `client_id` and `client_secret` fields in the plugin configuration UI (`config.schema.json`).

### Changed
- Refactored optional mode handling in `AirConditionerService` to support creating multiple switches (`Speed`, `WindFree`) based on the single "Speed and Windfree" configuration value.
- Updated `config.schema.json` to hide the `AccessToken` and `WebhookToken` fields from the Homebridge configuration UI, as these are handled automatically by the OAuth2 flow and persistent storage.

### Fixed
- Resolved TypeScript build error `TS2345: Argument of type 'OptionalMode | undefined' is not assignable...` by adding a non-null assertion (`!`) where `this.optionalMode` is used in the single-mode setup path within the constructor of `AirConditionerService`, ensuring type safety in that specific code path.