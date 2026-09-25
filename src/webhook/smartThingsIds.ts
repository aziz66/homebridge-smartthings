// SmartThings installedAppId / locationId values are UUIDs. They end up as URL path segments
// (installedapps/{id}/subscriptions), so anything else is rejected rather than stored or used.
const SMARTTHINGS_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export function isSmartThingsId(value: unknown): value is string {
  return typeof value === 'string' && SMARTTHINGS_ID_PATTERN.test(value);
}
