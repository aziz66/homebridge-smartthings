# Homebridge v2.0 Migration Tasks

## Task 1: Update BatteryService to Battery
**Priority**: High  
**Estimated Time**: 30 minutes  
**Risk**: Low

### Steps:
1. Rename `BatteryService` class to `Battery` in `src/services/batteryService.ts`
2. Update class name in constructor and all references
3. Update import in `src/multiServiceAccessory.ts`
4. Update capability map entry in `MultiServiceAccessory.capabilityMap`
5. Test battery functionality with a device

### Files to Modify:
- `src/services/batteryService.ts`
- `src/multiServiceAccessory.ts`

---

## Task 2: Update Characteristic Enum Access Patterns
**Priority**: High  
**Estimated Time**: 2-3 hours  
**Risk**: Medium

### Steps:
1. Audit all service files for `Characteristic.` enum usage
2. Replace with `api.hap.` namespace
3. Update platform constructor to expose `api.hap` to services
4. Test all device types after changes

### Files to Audit and Modify:
- `src/services/airConditionerService.ts`
- `src/services/batteryService.ts`
- `src/services/carbonMonoxideDetector.ts`
- `src/services/contactSensorService.ts`
- `src/services/doorService.ts`
- `src/services/fanSpeedService.ts`
- `src/services/fanSwitchLevelService.ts`
- `src/services/humidityService.ts`
- `src/services/leakDetector.ts`
- `src/services/lightSensorService.ts`
- `src/services/lightService.ts`
- `src/services/lockService.ts`
- `src/services/motionService.ts`
- `src/services/occupancySensorService.ts`
- `src/services/sensorService.ts`
- `src/services/smokeDetector.ts`
- `src/services/statelessProgrammableSwitchService.ts`
- `src/services/switchService.ts`
- `src/services/temperatureService.ts`
- `src/services/thermostatService.ts`
- `src/services/valveService.ts`
- `src/services/windowCoveringService.ts`

### Common Patterns to Replace:
```typescript
// Old
this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
this.platform.Characteristic.TargetHeatingCoolingState.AUTO

// New
this.platform.api.hap.StatusLowBattery.BATTERY_LEVEL_LOW
this.platform.api.hap.TargetHeatingCoolingState.AUTO
```

---

## Task 3: Fix Characteristic.getValue() Usage
**Priority**: High  
**Estimated Time**: 1 hour  
**Risk**: Medium

### Steps:
1. Locate `getValue()` calls in codebase
2. Replace with `.value` property access
3. Test polling functionality
4. Verify no breaking changes in behavior

### Files to Modify:
- `src/multiServiceAccessory.ts` (line 401)
- `src/basePlatformAccessory.ts` (line 162)

### Pattern to Replace:
```typescript
// Old
getValue().then((v) => {

// New
.value.then((v) => {
```

---

## Task 4: Update Storage Path Usage
**Priority**: Medium  
**Estimated Time**: 2 hours  
**Risk**: Medium

### Steps:
1. Import `HAPStorage` from homebridge
2. Replace `api.user.storagePath()` calls with `HAPStorage.setCustomStoragePath()`
3. Update all files using storage path
4. Test authentication persistence
5. Test crash loop manager storage

### Files to Modify:
- `src/platform.ts`
- `src/auth/tokenManager.ts`
- `src/auth/CrashLoopManager.ts`

### Pattern to Replace:
```typescript
// Old
this.api.user.storagePath()

// New
HAPStorage.setCustomStoragePath()
```

---

## Task 5: Update Package.json Engines
**Priority**: Low  
**Estimated Time**: 15 minutes  
**Risk**: Low

### Steps:
1. Update engines field in `package.json`
2. Add support for both v1.6.0+ and v2.0.0-beta.0+
3. Test package installation

### Files to Modify:
- `package.json`

### New Engines Field:
```json
"engines": {
  "node": ">=20.0.0",
  "homebridge": "^1.6.0 || ^2.0.0-beta.0"
}
```

---

## Task 6: Platform Constructor Updates
**Priority**: Medium  
**Estimated Time**: 1 hour  
**Risk**: Low

### Steps:
1. Update platform constructor to expose `api.hap` to services
2. Ensure all services have access to `api.hap` for enum access
3. Test service initialization

### Files to Modify:
- `src/platform.ts`
- `src/baseService.ts` (if needed)

---

## Task 7: Testing and Validation
**Priority**: High  
**Estimated Time**: 4-6 hours  
**Risk**: Low

### Steps:
1. **Unit Testing**
   - Test each service individually
   - Verify enum access works correctly
   - Test battery service functionality

2. **Integration Testing**
   - Test device discovery
   - Test authentication flow
   - Test webhook functionality
   - Test polling mechanisms

3. **Device Testing**
   - Test all supported device types
   - Verify real-time updates work
   - Test command sending
   - Test error handling

4. **Performance Testing**
   - Test with multiple devices
   - Verify no memory leaks
   - Check response times

5. **Backward Compatibility**
   - Test with Homebridge v1.x
   - Verify upgrade scenarios
   - Test configuration migration

---

## Task 8: Documentation Updates
**Priority**: Low  
**Estimated Time**: 1 hour  
**Risk**: Low

### Steps:
1. Update README.md with v2.0 support
2. Update CHANGELOG.md with migration notes
3. Add migration guide for users
4. Update any API documentation

### Files to Modify:
- `README.md`
- `CHANGELOG.md`

---

## Task 9: Final Validation
**Priority**: High  
**Estimated Time**: 2 hours  
**Risk**: Low

### Steps:
1. **Code Review**
   - Review all changes for consistency
   - Check for any missed enum references
   - Verify error handling

2. **Build Testing**
   - Run full build process
   - Check for TypeScript errors
   - Verify linting passes

3. **Installation Testing**
   - Test fresh installation
   - Test upgrade from previous version
   - Test with both v1.x and v2.0-beta

4. **User Acceptance Testing**
   - Test with real SmartThings devices
   - Verify all functionality works as expected
   - Test edge cases and error scenarios

---

## Dependencies Between Tasks

```
Task 1 (BatteryService) → Task 7 (Testing)
Task 2 (Enum Access) → Task 6 (Platform Updates) → Task 7 (Testing)
Task 3 (getValue) → Task 7 (Testing)
Task 4 (Storage Path) → Task 7 (Testing)
Task 5 (Package.json) → Task 7 (Testing)
Task 6 (Platform Updates) → Task 7 (Testing)
Task 7 (Testing) → Task 8 (Documentation)
Task 8 (Documentation) → Task 9 (Final Validation)
```

## Success Criteria for Each Task

### Task 1-6: Implementation Tasks
- [ ] Code compiles without errors
- [ ] No TypeScript warnings
- [ ] Linting passes
- [ ] Basic functionality works

### Task 7: Testing
- [ ] All device types tested
- [ ] Authentication works
- [ ] Real-time updates work
- [ ] Polling works
- [ ] Error handling works
- [ ] Performance acceptable

### Task 8: Documentation
- [ ] README updated
- [ ] CHANGELOG updated
- [ ] Migration guide created

### Task 9: Final Validation
- [ ] All tests pass
- [ ] Code review complete
- [ ] Installation tested
- [ ] User acceptance testing complete

## Rollback Plan for Each Task

### For Tasks 1-6:
- Keep original code in git history
- Use feature branches for each task
- Test thoroughly before merging

### For Task 7:
- If issues found, revert to previous working state
- Fix issues in separate commits
- Re-test after fixes

### For Tasks 8-9:
- Update documentation to reflect current state
- Mark any known issues
- Plan follow-up fixes if needed 