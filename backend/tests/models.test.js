import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  Booking,
  ServicePool,
} from '../src/models/index.js';

function hasIndex(model, fieldName, expectedValue) {
  return model.schema.indexes().some(([fields, opts]) => {
    if (expectedValue === 'unique') return Boolean(fields[fieldName] && opts?.unique);
    return fields[fieldName] === expectedValue;
  });
}

describe('Mongoose Models, 2dsphere/Unique Indexes & Password Hashing', () => {
  it('declares 2dsphere indexes on all geospatial collections', () => {
    assert.equal(hasIndex(TechnicianProfile, 'baseLocation', '2dsphere'), true);
    assert.equal(hasIndex(Booking, 'location', '2dsphere'), true);
    assert.equal(hasIndex(ServiceZone, 'centerLocation', '2dsphere'), true);
  });

  it('declares unique indexes where duplicate records must be prevented', () => {
    assert.equal(User.schema.path('email').options.unique, true);
    assert.equal(ServiceCategory.schema.path('slug').options.unique, true);
    assert.equal(ServiceZone.schema.path('code').options.unique, true);
    assert.equal(TechnicianProfile.schema.path('userId').options.unique, true);
  });

  it('strips passwordHash and __v when serializing User to JSON and verifies bcrypt comparePassword', async () => {
    const plain = 'SecretPass123!';
    const hashed = await bcrypt.hash(plain, 10);
    const user = new User({
      name: 'Test Customer',
      email: 'test@example.com',
      passwordHash: hashed,
      role: 'customer',
    });

    assert.equal(await user.comparePassword(plain), true);
    assert.equal(await user.comparePassword('WrongPass!'), false);

    const json = user.toJSON();
    assert.equal(json.passwordHash, undefined);
    assert.equal(json.__v, undefined);
    assert.equal(json.email, 'test@example.com');
  });

  it('validates ServiceZone required fields and GeoJSON coordinates', () => {
    const invalidZone = new ServiceZone({
      name: 'Green Park',
      code: 'KOL-GP',
      centerLocation: { type: 'Point', coordinates: [200, 22.5] },
    });
    const err = invalidZone.validateSync();
    assert.ok(err);
    assert.ok(err.errors['centerLocation.coordinates']);

    const validZone = new ServiceZone({
      name: 'Green Park',
      code: 'KOL-GP',
      centerLocation: { type: 'Point', coordinates: [88.3531, 22.5015] },
    });
    assert.equal(validZone.validateSync(), undefined);
  });

  it('rejects Booking when timeWindow.end <= timeWindow.start, price < 0, or coordinates invalid', () => {
    const now = Date.now();
    const invalidBooking = new Booking({
      customerId: new mongoose.Types.ObjectId(),
      serviceCategoryId: new mongoose.Types.ObjectId(),
      location: { type: 'Point', coordinates: [190, 22.5] },
      addressText: 'Green Park, Kolkata',
      timeWindow: {
        start: new Date(now + 3600_000),
        end: new Date(now + 1800_000),
      },
      estimatedPrice: -10,
    });

    const err = invalidBooking.validateSync();
    assert.ok(err);
    assert.ok(err.errors['timeWindow.end']);
    assert.ok(err.errors['location.coordinates']);
    assert.ok(err.errors.estimatedPrice);
  });

  it('validates TechnicianProfile currentLocation, lastLocationUpdate, and required baseLocation', () => {
    // 1. Missing baseLocation is rejected
    const missingBase = new TechnicianProfile({
      userId: new mongoose.Types.ObjectId(),
    });
    const errMissingBase = missingBase.validateSync();
    assert.ok(errMissingBase);
    assert.ok(errMissingBase.errors['baseLocation']);

    // 2. Valid profile without currentLocation defaults to null
    const validProfile = new TechnicianProfile({
      userId: new mongoose.Types.ObjectId(),
      baseLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
    });
    assert.equal(validProfile.validateSync(), undefined);
    assert.equal(validProfile.currentLocation, null);
    assert.equal(validProfile.lastLocationUpdate, null);

    // 3. Valid profile with optional currentLocation and lastLocationUpdate
    const updateTime = new Date();
    const withCurrent = new TechnicianProfile({
      userId: new mongoose.Types.ObjectId(),
      baseLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      currentLocation: { type: 'Point', coordinates: [88.3712, 22.5801] },
      lastLocationUpdate: updateTime,
    });
    assert.equal(withCurrent.validateSync(), undefined);
    assert.deepEqual(withCurrent.currentLocation.coordinates, [88.3712, 22.5801]);
    assert.equal(withCurrent.lastLocationUpdate, updateTime);

    // 4. Invalid currentLocation coordinates (out of range longitude) are rejected
    const invalidCurrent = new TechnicianProfile({
      userId: new mongoose.Types.ObjectId(),
      baseLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      currentLocation: { type: 'Point', coordinates: [195, 22.5801] },
    });
    const errInvalidCurrent = invalidCurrent.validateSync();
    assert.ok(errInvalidCurrent);
    assert.ok(errInvalidCurrent.errors['currentLocation.coordinates']);
  });

  it('validates ServicePool rejectedTechnicians schema, defaults to empty array and prevents duplicate IDs', () => {
    // 1. Defaults to empty array
    const pool = new ServicePool({
      serviceCategoryId: new mongoose.Types.ObjectId(),
      maxCapacity: 4,
      poolRadiusKm: 2,
      centroidLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
      aggregateTimeWindow: {
        start: new Date(Date.now() + 3600_000),
        end: new Date(Date.now() + 7200_000),
      },
      lockCutoffTime: new Date(Date.now() + 1800_000),
    });
    assert.deepEqual(pool.rejectedTechnicians, []);
    assert.deepEqual(pool.rejectedTechnicianIds, []);

    // 2. Accepts distinct technician IDs
    const tech1 = new mongoose.Types.ObjectId();
    const tech2 = new mongoose.Types.ObjectId();
    pool.rejectedTechnicians.push(tech1, tech2);
    const errValid = pool.validateSync();
    assert.equal(errValid, undefined);

    // 3. Rejects duplicate technician IDs
    pool.rejectedTechnicians.push(tech1);
    const errDup = pool.validateSync();
    assert.ok(errDup);
    assert.ok(errDup.errors['rejectedTechnicians']);
  });
});
