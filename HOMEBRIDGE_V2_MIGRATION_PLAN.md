# Homebridge v2.0 Migration Plan for SmartThings Plugin

## Overview
This document outlines the plan to migrate the SmartThings Homebridge plugin from Homebridge v1.x to v2.0 compatibility. The migration focuses on addressing breaking changes in HAP-NodeJS v1 and Homebridge v2 while maintaining all existing functionality.

## Current Status
- **Plugin Version**: 1.0.9
- **Current Homebridge Support**: >=1.3.5
- **Target Homebridge Support**: ^1.6.0 || ^2.0.0-beta.0
- **Node.js Support**: >=20.0.0 (already compliant)

## Breaking Changes to Address

### 1. HAP-NodeJS v1 Changes

#### 1.1 BatteryService Removal
- **Issue**: `BatteryService` has been removed in favor of `Battery`
- **Files Affected**: 
  - `src/services/batteryService.ts`
  - `src/multiServiceAccessory.ts`
- **Action**: Update service class name and imports

#### 1.2 Characteristic Enum Access Changes
- **Issue**: Use of enums off the `Characteristic` class is no longer supported
- **Current Pattern**: `Characteristic.Units`, `Characteristic.Formats`, `Characteristic.Perms`
- **New Pattern**: `api.hap.Units`, `api.hap.Formats`, `api.hap.Perms`
- **Files Affected**: All service files using characteristic enums
- **Action**: Update all enum references to use `api.hap` namespace

#### 1.3 Characteristic.getValue() Removal
- **Issue**: `Characteristic.getValue()` has been removed in favor of `Characteristic.value`
- **Files Affected**: 
  - `src/multiServiceAccessory.ts` (line 401)
  - `src/basePlatformAccessory.ts` (line 162)
- **Action**: Replace `getValue()` calls with `.value` property access

#### 1.4 Storage Path Changes
- **Issue**: Deprecated `storagePath` usage
- **Files Affected**:
  - `src/platform.ts`
  - `src/auth/tokenManager.ts`
  - `src/auth/CrashLoopManager.ts`
- **Action**: Switch to `HAPStorage.setCustomStoragePath`

### 2. Homebridge v2 Changes

#### 2.1 Engine Requirements Update
- **Issue**: Need to support both v1.6.0+ and v2.0.0-beta.0+
- **Action**: Update `package.json` engines field

#### 2.2 API Changes
- **Issue**: Potential API changes in Homebridge v2
- **Action**: Test with beta version and update as needed

## Migration Tasks

### Phase 1: HAP-NodeJS v1 Compatibility
1. **Update BatteryService to Battery**
   - Rename class and update imports
   - Test battery functionality

2. **Update Characteristic Enum Access**
   - Audit all service files for enum usage
   - Update to use `api.hap` namespace
   - Test all device types

3. **Fix Characteristic.getValue() Usage**
   - Replace with `.value` property access
   - Test polling functionality

4. **Update Storage Path Usage**
   - Implement `HAPStorage.setCustomStoragePath`
   - Test authentication and token storage

### Phase 2: Homebridge v2 Compatibility
1. **Update Package.json**
   - Add v2.0.0-beta.0 support
   - Test installation and registration

2. **API Compatibility Testing**
   - Test with Homebridge v2 beta
   - Address any API changes

### Phase 3: Testing and Validation
1. **Functional Testing**
   - Test all device types
   - Test authentication flow
   - Test webhook functionality
   - Test polling and real-time updates

2. **Performance Testing**
   - Verify no performance regressions
   - Test with multiple devices

3. **Backward Compatibility**
   - Ensure v1.x compatibility maintained
   - Test upgrade scenarios

## Risk Assessment

### Low Risk
- BatteryService rename (simple refactoring)
- Characteristic enum updates (straightforward replacements)
- Package.json updates

### Medium Risk
- Storage path changes (affects authentication persistence)
- Characteristic.getValue() changes (affects polling)

### High Risk
- Homebridge v2 API changes (unknown until tested)
- Potential breaking changes in beta versions

## Success Criteria
1. Plugin installs and runs on Homebridge v2.0.0-beta.0
2. All device types function correctly
3. Authentication and token management work
4. Real-time updates via webhooks work
5. Polling functionality works
6. Backward compatibility with v1.x maintained
7. No performance regressions

## Rollback Plan
- Maintain v1.x compatibility throughout migration
- Use feature flags if needed for v2-specific code
- Keep v1.x as fallback in package.json engines

## Timeline
- **Phase 1**: 1-2 days
- **Phase 2**: 1 day
- **Phase 3**: 2-3 days
- **Total**: 4-6 days

## Notes
- Homebridge v2 is still in beta, so changes may occur
- Monitor Homebridge v2 release notes for additional changes
- Consider implementing feature detection for v2-specific features 