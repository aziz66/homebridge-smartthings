# Changelog
All notable changes to this project will be documented in this file.

## [1.0.15] - Television Service Support & IgnoreDevices Bug Fixes
### Added
- **🎬 Television Service**: Samsung TVs now appear as proper Television accessories in HomeKit instead of simple switches
- **📺 Input Source Control**: Full support for HDMI inputs, TV tuner, and custom input names from SmartThings
- **🔊 Audio Controls**: Volume control, mute/unmute, and volume up/down buttons via TelevisionSpeaker service
- **🎨 Picture Mode Support**: Control Samsung picture modes (Standard, Dynamic, Movie, etc.) from HomeKit
- **🎮 Remote Control**: Support for media playback controls (rewind, fast forward, channel up/down)
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
