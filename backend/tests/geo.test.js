import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCoordinates,
  toGeoJSONPoint,
  parseGeoInput,
  fromGeoJSONPoint,
  haversineDistanceKm,
} from '../src/utils/geo.js';

describe('GeoJSON & Coordinate Utilities', () => {
  it('converts { lat, lng } to GeoJSON [lng, lat] order', () => {
    const point = toGeoJSONPoint(22.5176, 88.3639);
    assert.deepEqual(point, {
      type: 'Point',
      coordinates: [88.3639, 22.5176],
    });
  });

  it('parses both { lat, lng } and GeoJSON Point inputs consistently', () => {
    const fromLatLng = parseGeoInput({ lat: 22.5015, lng: 88.3531 });
    const fromGeoJson = parseGeoInput({ type: 'Point', coordinates: [88.3531, 22.5015] });
    assert.deepEqual(fromLatLng, fromGeoJson);
    assert.deepEqual(fromGeoJSONPoint(fromGeoJson), { lat: 22.5015, lng: 88.3531 });
  });

  it('rejects out-of-bounds or non-numeric coordinates', () => {
    assert.throws(() => validateCoordinates(95, 88), { code: 'INVALID_COORDINATES' });
    assert.throws(() => validateCoordinates(22, -185), { code: 'INVALID_COORDINATES' });
    assert.throws(() => validateCoordinates('abc', 88), { code: 'INVALID_COORDINATES' });
  });

  it('computes Haversine straight-line distance accurately for Kolkata test coordinates', () => {
    const jadavpur = toGeoJSONPoint(22.5015, 88.3531);
    const ballygunge = toGeoJSONPoint(22.5176, 88.3639);
    const km = haversineDistanceKm(jadavpur, ballygunge);

    assert.ok(km > 1.8 && km < 2.5, `Expected ~2.1 km straight-line distance, got ${km}`);
    assert.equal(haversineDistanceKm(jadavpur, jadavpur), 0);
  });
});
