import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelevisionService } from '../src/services/televisionService';

// The TV app catalog is hardcoded in three places that have to stay in sync: the runtime
// catalog, the config schema (enum + index-aligned enumNames) and the settings UI.
type Catalog = Array<[string, string]>;

const ROOT = join(__dirname, '..');
const runtimeCatalog: Catalog = Object.entries(
  (TelevisionService as unknown as { AVAILABLE_APPS: Record<string, string> }).AVAILABLE_APPS,
);

function schemaCatalog(): Catalog {
  const schema = JSON.parse(readFileSync(join(ROOT, 'config.schema.json'), 'utf8'));
  const items = schema.schema.properties.tvApps.items;
  assert.equal(items.enum.length, items.enumNames.length, 'tvApps enum and enumNames must be the same length');
  return items.enum.map((id: string, i: number) => [id, items.enumNames[i]]);
}

function uiCatalog(): Catalog {
  const html = readFileSync(join(ROOT, 'homebridge-ui', 'public', 'index.html'), 'utf8');
  const block = html.match(/TV_APPS_CATALOG\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, 'TV_APPS_CATALOG not found in homebridge-ui/public/index.html');
  return [...block[1].matchAll(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'\s*\}/g)].map(m => [m[1], m[2]] as [string, string]);
}

function assertSameCatalog(actual: Catalog) {
  assert.equal(actual.length, runtimeCatalog.length, 'catalog sizes differ (missing or duplicate entry)');
  assert.deepEqual(new Map(actual), new Map(runtimeCatalog));
}

test('config schema lists the same TV apps as the runtime catalog', () => {
  assertSameCatalog(schemaCatalog());
});

test('settings UI lists the same TV apps as the runtime catalog', () => {
  assertSameCatalog(uiCatalog());
});

test('offers the Prime Video app ID used by older Samsung TVs (#59)', () => {
  const catalog = new Map(runtimeCatalog);
  assert.equal(catalog.get('3201910019365'), 'Prime Video');
  assert.equal(catalog.get('3201512006785'), 'Prime Video (older TVs)');
});
