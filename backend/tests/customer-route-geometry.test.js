import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSharedGeometry } from '../src/modules/routing/customerRoute.service.js';
import { OsrmRoutingProvider } from '../src/modules/routing/providers/osrmRoutingProvider.js';
import { setDefaultRoutingProvider } from '../src/modules/routing/routingProvider.factory.js';

test('road overview uses ordered area centres, caches the line, and falls back on provider failure', async t => {
  setDefaultRoutingProvider(new OsrmRoutingProvider({ baseUrl: 'https://routing.example' }));
  t.after(() => setDefaultRoutingProvider(null));
  const pins = [[88.36012, 22.52014], [88.36018, 22.52019], [88.36114, 22.52021]];
  const centres = [[88.3605, 22.5205], [88.3615, 22.5205]];
  const road = [centres[0], [88.3608, 22.521], centres[1]];
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).pathname, '/route/v1/driving/88.3605,22.5205;88.3615,22.5205');
    return { ok: true, json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: road } }] }) };
  });
  const geometry = await planSharedGeometry(pins, 'osrm');
  assert.deepEqual(geometry.line, road);
  assert.deepEqual(await planSharedGeometry(pins, 'osrm', geometry), geometry);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => ({ ok: false }));
  assert.deepEqual((await planSharedGeometry(pins.toReversed(), 'osrm', geometry)).line, []);
  assert.deepEqual((await planSharedGeometry(pins, 'mock')).line, []);
  assert.deepEqual((await planSharedGeometry(pins.slice(0, 2), 'osrm')).line, []);
  assert.equal(fetch.mock.callCount(), 2);
});
