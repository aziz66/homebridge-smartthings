
For Plugin Developers
---------------------

[](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0#for-plugin-developers)

### `HAP-NodeJS v1`

[](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0#hap-nodejs-v1)

You may need to change your plugins because of the breaking changes in HAP-NodeJS v1.

To see the complete set of changes between `v0.12.3` and `v1.0.0`, see the [version file differences](https://github.com/homebridge/HAP-NodeJS/compare/v0.12.2...v1.0.0).

-   Common long-deprecated code patterns that may need updating:
    -   `BatteryService` has been removed in favour of `Battery`
    -   Use of enums off the `Characteristic` class is no longer supported:
        -   Instead of `const Units = Characteristic.Units;` you will need to use `const Units = api.hap.Units;`
        -   Instead of `const Formats = Characteristic.Formats;` you will need to use `const Formats = api.hap.Formats;`
        -   Instead of `const Perms = Characteristic.Perms;` you will need to use `const Perms = api.hap.Perms;`
    -   `Characteristic.getValue()` has been removed in favour of `Characteristic.value`
    -   `Accessory.getServiceByUUIDAndSubType()` has been removed: you can swap this for `Accessory.getServiceById()`
    -   `Accessory.updateReachability()` has been removed: reachability in general is no longer supported
    -   `Accessory.setPrimaryService(Service)` has been removed: use `Service.setPrimaryService()` instead
    -   Remove the long-deprecated init().
    -   Deprecate Core, BridgedCore and legacy Camera characteristics
        -   For deprecated Core and BridgedCore see: <https://github.com/homebridge/HAP-NodeJS/wiki/Deprecation-of-Core-and-BridgeCore>
    -   For deprecated `storagePath` switch to `HAPStorage.setCustomStoragePath`
    -   For `AudioCodec` switch to AudioStreamingCodec
    -   For `VideoCodec` switch to H264CodecParameters
    -   For `StreamAudioParams` switch to AudioStreamingOptions
    -   For `StreamVideoParams` switch to VideoStreamingOptions
    -   For `cameraSource` switch to `CameraController`
    -   Other deprecated code to highlight removed: `useLegacyAdvertiser`, `AccessoryLoader`
    -   For Fix: Naming for `Characteristic.ProgramMode` has been corrected from `PROGRAM_SCHEDULED_MANUAL_MODE_` to `PROGRAM_SCHEDULED_MANUAL_MODE`

### `Homebridge v2`

[](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0#homebridge-v2)

You may need to change your plugins because of the breaking changes in Homebridge v2.

Homebridge 2.0 is still in beta. To see the current changes between `v1.8.3` and `v2.0.0`, see the [version file differences](https://github.com/homebridge/homebridge/compare/latest...beta-2.0.0).

Once you have tested your plugin(s) function correctly on Homebridge v2, you can update your `package.json`'s `engines.homebridge` value to show that your plugin is ready.

```source-json
  "engines": {
    "homebridge": "^1.6.0 || ^2.0.0-beta.0",
    "node": "^18.20.4 || ^20.15.1 || ^22"
  },
```

Users will see a green tick in the readiness check in the UI once they have installed a version of your plugin with this in the `engines`.

Once Homebridge v2 has been released, you can remove the `-beta.0` from the `homebridge` versions.