# Changelog
All notable changes to this project will be documented in this file.

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
