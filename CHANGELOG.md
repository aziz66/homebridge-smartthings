# Changelog
All notable changes to this project will be documented in this file.

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
