import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCentroid,
  computeIntervalIntersection,
  calculateMatchingScore,
} from '../src/modules/pools/matching.service.js';

describe('Phase 4 Pool Matching Unit Tests', () => {
  it('computes geographic centroid of GeoJSON points accurately', () => {
    const points = [
      { type: 'Point', coordinates: [88.35, 22.50] },
      { type: 'Point', coordinates: [88.37, 22.52] },
    ];

    const centroid = computeCentroid(points);
    assert.equal(centroid.type, 'Point');
    assert.equal(Number(centroid.coordinates[0].toFixed(2)), 88.36);
    assert.equal(Number(centroid.coordinates[1].toFixed(2)), 22.51);
  });

  it('computes valid strict interval intersection for overlapping windows', () => {
    const windowA = {
      start: new Date('2026-11-20T10:00:00.000Z'),
      end: new Date('2026-11-20T13:00:00.000Z'),
    };
    const windowB = {
      start: new Date('2026-11-20T11:00:00.000Z'),
      end: new Date('2026-11-20T14:00:00.000Z'),
    };

    const intersection = computeIntervalIntersection(windowA, windowB);
    assert.notEqual(intersection, null);
    assert.equal(intersection.start.toISOString(), '2026-11-20T11:00:00.000Z');
    assert.equal(intersection.end.toISOString(), '2026-11-20T13:00:00.000Z');
  });

  it('returns null when time windows do not overlap', () => {
    const windowA = {
      start: new Date('2026-11-20T09:00:00.000Z'),
      end: new Date('2026-11-20T11:00:00.000Z'),
    };
    const windowB = {
      start: new Date('2026-11-20T12:00:00.000Z'),
      end: new Date('2026-11-20T14:00:00.000Z'),
    };

    const intersection = computeIntervalIntersection(windowA, windowB);
    assert.equal(intersection, null);
  });

  it('returns null when time windows abut but do not strictly intersect (start == end)', () => {
    const windowA = {
      start: new Date('2026-11-20T09:00:00.000Z'),
      end: new Date('2026-11-20T11:00:00.000Z'),
    };
    const windowB = {
      start: new Date('2026-11-20T11:00:00.000Z'),
      end: new Date('2026-11-20T13:00:00.000Z'),
    };

    const intersection = computeIntervalIntersection(windowA, windowB);
    assert.equal(intersection, null);
  });

  it('produces deterministic matching scores favoring closer distance and higher overlap', () => {
    // Candidate 1: 0.5 km away, full 2hr overlap, 2/4 members
    const score1 = calculateMatchingScore({
      distanceKm: 0.5,
      poolRadiusKm: 2.0,
      overlapDurationMs: 2 * 3600 * 1000,
      bookingDurationMs: 2 * 3600 * 1000,
      currentMembers: 2,
      maxCapacity: 4,
    });

    // Candidate 2: 1.8 km away, partial 1hr overlap, 2/4 members
    const score2 = calculateMatchingScore({
      distanceKm: 1.8,
      poolRadiusKm: 2.0,
      overlapDurationMs: 1 * 3600 * 1000,
      bookingDurationMs: 2 * 3600 * 1000,
      currentMembers: 2,
      maxCapacity: 4,
    });

    assert.ok(score1 > score2, `Closer candidate (${score1}) must score strictly higher than distant candidate (${score2})`);
  });
});
