// Helpers for Samsung Family Hub multi-zone refrigerators (e.g. RF29DB9600QLA).
// Sub-components (freezer, FlexZone, CVRoom) report null on the standard
// `temperatureMeasurement` capability — the real per-compartment temperatures
// live in an OCF blob at `main.status.samsungce.driverState.driverState.value`.

interface DeviceLike {
  components: Array<{
    id: string;
    capabilities: Array<{ id: string }>;
  }>;
}

interface OcfItemRep {
  temperature?: number;
  'x.com.samsung.da.items'?: Array<{
    'x.com.samsung.da.id'?: string;
    'x.com.samsung.da.description'?: string;
    'x.com.samsung.da.current'?: string;
  }>;
}

interface OcfItem {
  href?: string;
  rep?: OcfItemRep;
}

type OcfDriverStateValue = OcfItem[] | { [key: string]: OcfItem[] | unknown };

// Map componentId → list of OCF hrefs to try, in order of preference.
const COMPONENT_TEMPERATURE_PATHS: Record<string, string[]> = {
  main: ['/temperature/current/cooler/0', '/temperatures/vs/0'],
  freezer: ['/temperature/current/freezer/0', '/temperatures/vs/0'],
  cooler: ['/temperature/current/cooler/0', '/temperatures/vs/0'],
  cvroom: ['/temperature/current/cooler/0'],
  onedoor: ['/temperature/current/cooler/0'],
  flexzone: ['/temperature/current/cooler/0'],
};

const COMPONENT_DISPLAY_NAMES: Record<string, string> = {
  main: 'Refrigerator',
  cooler: 'Refrigerator',
  freezer: 'Freezer',
  cvroom: 'FlexZone',
  onedoor: 'FlexZone',
  flexzone: 'FlexZone',
};

function getMainCapabilities(device: DeviceLike): string[] {
  const main = device.components.find((c) => c.id === 'main');
  if (!main) {
    return [];
  }
  return main.capabilities.map((c) => c.id);
}

export function hasRefrigeratorOcfDriver(device: DeviceLike): boolean {
  return getMainCapabilities(device).includes('samsungce.driverState');
}

export function hasDisabledComponentsCapability(device: DeviceLike): boolean {
  return getMainCapabilities(device).includes('custom.disabledComponents');
}

export function getRefrigeratorComponentDisplayName(componentId: string): string | null {
  return COMPONENT_DISPLAY_NAMES[componentId.toLowerCase()] ?? null;
}

// Pull the disabled-component IDs out of main's status. Returns [] if the
// shape doesn't match (defensive — Samsung occasionally renames OCF keys).
// SmartThings keys capabilities flat at the top of mainStatus
// (e.g. mainStatus["custom.disabledComponents"]); a legacy nested shape
// (mainStatus.custom.disabledComponents…) is checked as a fallback.
export function extractDisabledComponents(mainStatus: Record<string, unknown> | undefined): string[] {
  if (!mainStatus || typeof mainStatus !== 'object') {
    return [];
  }

  const flat = (mainStatus as Record<string, unknown>)['custom.disabledComponents'];
  if (flat && typeof flat === 'object') {
    const inner = (flat as Record<string, unknown>).disabledComponents;
    if (inner && typeof inner === 'object') {
      const value = (inner as Record<string, unknown>).value;
      if (Array.isArray(value)) {
        return value.filter((v): v is string => typeof v === 'string');
      }
    }
  }

  const custom = (mainStatus as Record<string, unknown>).custom;
  if (!custom || typeof custom !== 'object') {
    return [];
  }
  const wrapper = (custom as Record<string, unknown>).disabledComponents;
  if (!wrapper || typeof wrapper !== 'object') {
    return [];
  }
  const inner = (wrapper as Record<string, unknown>).disabledComponents;
  if (!inner || typeof inner !== 'object') {
    return [];
  }
  const value = (inner as Record<string, unknown>).value;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === 'string');
}

function unwrapDriverStateItems(value: unknown): OcfItem[] | null {
  if (Array.isArray(value)) {
    return value as OcfItem[];
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  // Samsung typically wraps the array under "device/0", but accept any key
  // that contains an array — shape drift across firmware revisions.
  const preferred = obj['device/0'];
  if (Array.isArray(preferred)) {
    return preferred as OcfItem[];
  }
  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key])) {
      return obj[key] as OcfItem[];
    }
  }
  return null;
}

function readDriverStateValue(mainStatus: Record<string, unknown> | undefined): OcfDriverStateValue | null {
  if (!mainStatus) {
    return null;
  }

  const flat = (mainStatus as Record<string, unknown>)['samsungce.driverState'];
  if (flat && typeof flat === 'object') {
    const inner = (flat as Record<string, unknown>).driverState;
    if (inner && typeof inner === 'object') {
      const value = (inner as Record<string, unknown>).value;
      if (value !== undefined && value !== null) {
        return value as OcfDriverStateValue;
      }
    }
  }

  const samsungce = (mainStatus as Record<string, unknown>).samsungce;
  if (!samsungce || typeof samsungce !== 'object') {
    return null;
  }
  const driverStateOuter = (samsungce as Record<string, unknown>).driverState;
  if (!driverStateOuter || typeof driverStateOuter !== 'object') {
    return null;
  }
  const driverStateInner = (driverStateOuter as Record<string, unknown>).driverState;
  if (!driverStateInner || typeof driverStateInner !== 'object') {
    return null;
  }
  const value = (driverStateInner as Record<string, unknown>).value;
  if (value === undefined || value === null) {
    return null;
  }
  return value as OcfDriverStateValue;
}

function extractFromItemsArray(items: NonNullable<OcfItemRep['x.com.samsung.da.items']>, componentId: string): number | null {
  // For the /temperatures/vs/0 path, items are tagged: id "1" / description "Fridge" = main, id "0" / "Freezer" = freezer.
  const lookup: Record<string, { id: string; description: string }> = {
    main: { id: '1', description: 'Fridge' },
    cooler: { id: '1', description: 'Fridge' },
    freezer: { id: '0', description: 'Freezer' },
  };
  const target = lookup[componentId.toLowerCase()];
  if (!target) {
    return null;
  }
  const match = items.find(
    (i) => i['x.com.samsung.da.id'] === target.id || i['x.com.samsung.da.description'] === target.description,
  );
  if (!match || match['x.com.samsung.da.current'] === undefined) {
    return null;
  }
  const parsed = parseFloat(match['x.com.samsung.da.current']);
  return Number.isFinite(parsed) ? parsed : null;
}

// Returns temperature in °F if found, or null. OCF data on Samsung fridges is reported in Fahrenheit.
export function extractRefrigeratorTemperature(
  mainStatus: Record<string, unknown> | undefined,
  componentId: string,
): number | null {
  const driverStateValue = readDriverStateValue(mainStatus);
  if (driverStateValue === null) {
    return null;
  }

  const items = unwrapDriverStateItems(driverStateValue);
  if (!items || items.length === 0) {
    return null;
  }

  const paths = COMPONENT_TEMPERATURE_PATHS[componentId.toLowerCase()] ?? ['/temperatures/vs/0'];

  for (const path of paths) {
    const item = items.find((entry) => entry.href === path);
    if (!item || !item.rep) {
      continue;
    }
    if (typeof item.rep.temperature === 'number' && Number.isFinite(item.rep.temperature)) {
      return item.rep.temperature;
    }
    const itemsArray = item.rep['x.com.samsung.da.items'];
    if (Array.isArray(itemsArray)) {
      const value = extractFromItemsArray(itemsArray, componentId);
      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}
