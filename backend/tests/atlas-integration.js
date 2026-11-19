import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { validateEnv } from '../src/config/env.js';
import { connectDB, disconnectDB, getDbStatus, runInTransaction } from '../src/config/db.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  Booking,
  Notification,
} from '../src/models/index.js';
import { toGeoJSONPoint, haversineDistanceKm } from '../src/utils/geo.js';

describe('MongoDB Atlas Real Database Integration Tests', () => {
  const TEST_TAG = `__INTEG_TEST_${Date.now()}__`;

  before(async () => {
    validateEnv();
    await connectDB();
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await disconnectDB();
  });

  async function cleanup() {
    await User.deleteMany({ email: { $regex: /__integ_test_/i } });
    await ServiceCategory.deleteMany({ slug: { $regex: /__integ_test_/i } });
    await ServiceZone.deleteMany({ code: { $regex: /__INTEG_TEST_/i } });
    await Booking.deleteMany({ notes: { $regex: /__INTEG_TEST_/i } });
    await Notification.deleteMany({ title: { $regex: /__INTEG_TEST_/i } });
  }

  it('verifies Atlas connection state and Replica Set ACID transaction support', async () => {
    const status = getDbStatus();
    assert.equal(status.state, 'connected');
    assert.equal(status.transactionsSupported, true);
  });

  it('verifies expected 2dsphere, unique and compound indexes exist in Atlas', async () => {
    const db = mongoose.connection.db;

    // users
    const userIndexes = await db.collection('users').indexes();
    const emailIdx = userIndexes.find((i) => i.name === 'email_1');
    assert.ok(emailIdx, 'email_1 index must exist on users');
    assert.equal(emailIdx.unique, true, 'email_1 must be unique');

    // servicecategories
    const catIndexes = await db.collection('servicecategories').indexes();
    const slugIdx = catIndexes.find((i) => i.name === 'slug_1');
    assert.ok(slugIdx, 'slug_1 index must exist on servicecategories');
    assert.equal(slugIdx.unique, true, 'slug_1 must be unique');

    // servicezones
    const zoneIndexes = await db.collection('servicezones').indexes();
    const zoneCodeIdx = zoneIndexes.find((i) => i.name === 'code_1');
    assert.ok(zoneCodeIdx, 'code_1 index must exist on servicezones');
    assert.equal(zoneCodeIdx.unique, true, 'code_1 must be unique');
    const zone2d = zoneIndexes.find((i) => i.name === 'centerLocation_2dsphere');
    assert.ok(zone2d, 'centerLocation_2dsphere index must exist on servicezones');
    assert.equal(zone2d.key.centerLocation, '2dsphere');

    // technicianprofiles
    const techIndexes = await db.collection('technicianprofiles').indexes();
    const techUserIdx = techIndexes.find((i) => i.name === 'userId_1');
    assert.ok(techUserIdx, 'userId_1 index must exist on technicianprofiles');
    assert.equal(techUserIdx.unique, true, 'userId_1 must be unique');
    const tech2d = techIndexes.find((i) => i.name === 'baseLocation_2dsphere');
    assert.ok(tech2d, 'baseLocation_2dsphere index must exist on technicianprofiles');
    assert.equal(tech2d.key.baseLocation, '2dsphere');
    const techStatusIdx = techIndexes.find(
      (i) => i.name === 'availabilityStatus_1_approvalStatus_1'
    );
    assert.ok(techStatusIdx, 'availabilityStatus_1_approvalStatus_1 compound index must exist');

    // bookings
    const bookingIndexes = await db.collection('bookings').indexes();
    const booking2d = bookingIndexes.find((i) => i.name === 'location_2dsphere');
    assert.ok(booking2d, 'location_2dsphere index must exist on bookings');
    assert.equal(booking2d.key.location, '2dsphere');
    const bookingCompound1 = bookingIndexes.find(
      (i) => i.name === 'status_1_serviceCategoryId_1_timeWindow.start_1'
    );
    assert.ok(bookingCompound1, 'status_1_serviceCategoryId_1_timeWindow.start_1 compound index must exist');
    const bookingCompound2 = bookingIndexes.find((i) => i.name === 'customerId_1_createdAt_-1');
    assert.ok(bookingCompound2, 'customerId_1_createdAt_-1 compound index must exist');

    // notifications
    const notifIndexes = await db.collection('notifications').indexes();
    const notifCompound = notifIndexes.find((i) => i.name === 'userId_1_isRead_1_createdAt_-1');
    assert.ok(notifCompound, 'userId_1_isRead_1_createdAt_-1 compound index must exist');
  });

  it('verifies actual CRUD persistence for Users', async () => {
    const email = `user_${TEST_TAG.toLowerCase()}@test.smartpool.local`;
    const user = await User.create({
      name: 'Integration User',
      email,
      phone: '+91-9876543201',
      passwordHash: 'ValidPassword123!',
      role: 'customer',
    });
    assert.ok(user._id);

    const fetched = await User.findById(user._id);
    assert.equal(fetched?.email, email);

    fetched.name = 'Integration User Updated';
    await fetched.save();

    const updated = await User.findById(user._id);
    assert.equal(updated?.name, 'Integration User Updated');

    await User.deleteOne({ _id: user._id });
    const deleted = await User.findById(user._id);
    assert.equal(deleted, null);
  });

  it('verifies actual CRUD persistence for ServiceCategories', async () => {
    const slug = `cat-${TEST_TAG.toLowerCase().replace(/_/g, '-')}`;
    const cat = await ServiceCategory.create({
      name: 'Integration Category',
      slug,
      description: 'Test category description',
      baseIndividualPrice: 750,
      estimatedDurationMins: 60,
      defaultPoolRadiusKm: 2.5,
      maxPoolSize: 4,
      poolLockCutoffMins: 45,
    });
    assert.ok(cat._id);

    const fetched = await ServiceCategory.findById(cat._id);
    assert.equal(fetched?.slug, slug);

    fetched.baseIndividualPrice = 800;
    await fetched.save();

    const updated = await ServiceCategory.findById(cat._id);
    assert.equal(updated?.baseIndividualPrice, 800);

    await ServiceCategory.deleteOne({ _id: cat._id });
    const deleted = await ServiceCategory.findById(cat._id);
    assert.equal(deleted, null);
  });

  it('verifies actual CRUD persistence for ServiceZones', async () => {
    const code = `ZONE-${TEST_TAG.replace(/[^A-Z0-9]/g, '')}`;
    const zone = await ServiceZone.create({
      name: 'Integration Zone',
      code,
      city: 'Kolkata',
      centerLocation: toGeoJSONPoint(22.5600, 88.3700),
      radiusKm: 3.0,
    });
    assert.ok(zone._id);

    const fetched = await ServiceZone.findById(zone._id);
    assert.equal(fetched?.code, code);

    fetched.radiusKm = 4.5;
    await fetched.save();

    const updated = await ServiceZone.findById(zone._id);
    assert.equal(updated?.radiusKm, 4.5);

    await ServiceZone.deleteOne({ _id: zone._id });
    const deleted = await ServiceZone.findById(zone._id);
    assert.equal(deleted, null);
  });

  it('verifies actual CRUD persistence for TechnicianProfiles', async () => {
    const techUser = await User.create({
      name: 'Integration Tech',
      email: `tech_${TEST_TAG.toLowerCase()}@test.smartpool.local`,
      phone: '+91-9876543202',
      passwordHash: 'ValidPassword123!',
      role: 'technician',
    });
    const profile = await TechnicianProfile.create({
      userId: techUser._id,
      baseLocation: toGeoJSONPoint(22.5100, 88.3600),
      addressText: 'South Kolkata',
      serviceRadiusKm: 7,
      maxPoolCapacity: 4,
      availabilityStatus: 'offline',
      approvalStatus: 'pending',
    });
    assert.ok(profile._id);

    const fetched = await TechnicianProfile.findById(profile._id);
    assert.equal(String(fetched?.userId), String(techUser._id));

    fetched.availabilityStatus = 'available';
    await fetched.save();

    const updated = await TechnicianProfile.findById(profile._id);
    assert.equal(updated?.availabilityStatus, 'available');

    await TechnicianProfile.deleteOne({ _id: profile._id });
    await User.deleteOne({ _id: techUser._id });

    const deleted = await TechnicianProfile.findById(profile._id);
    assert.equal(deleted, null);
  });

  it('verifies actual CRUD persistence for Bookings', async () => {
    const customer = await User.create({
      name: 'Integration Customer',
      email: `cust_${TEST_TAG.toLowerCase()}@test.smartpool.local`,
      phone: '+91-9876543203',
      passwordHash: 'ValidPassword123!',
      role: 'customer',
    });
    const category = await ServiceCategory.findOne({ isActive: true });
    assert.ok(category, 'Active category must exist from seed');

    const now = new Date();
    const booking = await Booking.create({
      customerId: customer._id,
      serviceCategoryId: category._id,
      location: toGeoJSONPoint(22.5200, 88.3600),
      addressText: 'Ballygunge integration test address',
      timeWindow: {
        start: new Date(now.getTime() + 3600000),
        end: new Date(now.getTime() + 7200000),
      },
      bookingMode: 'pool',
      status: 'pending',
      estimatedPrice: 450,
      notes: `${TEST_TAG} Booking`,
    });
    assert.ok(booking._id);

    const fetched = await Booking.findById(booking._id);
    assert.equal(fetched?.notes, `${TEST_TAG} Booking`);

    fetched.status = 'confirmed';
    await fetched.save();

    const updated = await Booking.findById(booking._id);
    assert.equal(updated?.status, 'confirmed');

    await Booking.deleteOne({ _id: booking._id });
    await User.deleteOne({ _id: customer._id });

    const deleted = await Booking.findById(booking._id);
    assert.equal(deleted, null);
  });

  it('verifies actual CRUD persistence for Notifications', async () => {
    const user = await User.create({
      name: 'Notif Customer',
      email: `notif_${TEST_TAG.toLowerCase()}@test.smartpool.local`,
      phone: '+91-9876543204',
      passwordHash: 'ValidPassword123!',
      role: 'customer',
    });
    const notif = await Notification.create({
      userId: user._id,
      role: 'customer',
      title: `${TEST_TAG} Notif`,
      message: 'Integration test message',
      type: 'system',
      isRead: false,
    });
    assert.ok(notif._id);

    const fetched = await Notification.findById(notif._id);
    assert.equal(fetched?.title, `${TEST_TAG} Notif`);

    fetched.isRead = true;
    await fetched.save();

    const updated = await Notification.findById(notif._id);
    assert.equal(updated?.isRead, true);

    await Notification.deleteOne({ _id: notif._id });
    await User.deleteOne({ _id: user._id });

    const deleted = await Notification.findById(notif._id);
    assert.equal(deleted, null);
  });

  it('verifies technician registration creates User and TechnicianProfile together in a real transaction', async () => {
    const techEmail = `tx_ok_${TEST_TAG.toLowerCase()}@test.smartpool.local`;
    let newUserId = null;
    let newProfileId = null;

    await runInTransaction(async (session) => {
      const [u] = await User.create(
        [
          {
            name: 'Atomic Tech',
            email: techEmail,
            phone: '+91-9876543205',
            passwordHash: 'ValidPassword123!',
            role: 'technician',
          },
        ],
        { session }
      );
      newUserId = u._id;

      const [p] = await TechnicianProfile.create(
        [
          {
            userId: u._id,
            baseLocation: toGeoJSONPoint(22.518, 88.365),
            addressText: 'Ballygunge Phari',
            serviceRadiusKm: 5,
            maxPoolCapacity: 4,
            availabilityStatus: 'offline',
            approvalStatus: 'pending',
          },
        ],
        { session }
      );
      newProfileId = p._id;
    });

    const committedUser = await User.findById(newUserId);
    const committedProfile = await TechnicianProfile.findById(newProfileId);

    assert.ok(committedUser, 'User must be committed');
    assert.ok(committedProfile, 'TechnicianProfile must be committed');
    assert.equal(String(committedProfile.userId), String(committedUser._id));

    await TechnicianProfile.deleteOne({ _id: newProfileId });
    await User.deleteOne({ _id: newUserId });
  });

  it('forces TechnicianProfile failure and verifies User document rollback in Atlas', async () => {
    const rollbackEmail = `tx_fail_${TEST_TAG.toLowerCase()}@test.smartpool.local`;
    let attemptedUserId = null;

    await assert.rejects(
      async () => {
        await runInTransaction(async (session) => {
          const [u] = await User.create(
            [
              {
                name: 'Rollback Candidate',
                email: rollbackEmail,
                phone: '+91-9876543206',
                passwordHash: 'ValidPassword123!',
                role: 'technician',
              },
            ],
            { session }
          );
          attemptedUserId = u._id;

          // Intentionally throw inside transaction
          throw new Error('FORCE_TECHNICIAN_CREATION_FAILURE');
        });
      },
      /FORCE_TECHNICIAN_CREATION_FAILURE/
    );

    // Verify User was rolled back in Atlas
    const userInDb = await User.findOne({ email: rollbackEmail });
    assert.equal(userInDb, null, 'User document must NOT exist in Atlas after rollback');

    if (attemptedUserId) {
      const userById = await User.findById(attemptedUserId);
      assert.equal(userById, null, 'User document by ID must NOT exist in Atlas after rollback');
    }
  });

  it('runs real $nearSphere queries on seeded Kolkata zones respecting radius filter and distance ordering', async () => {
    // Ballygunge center: lat 22.528, lng 88.365
    const center = { lat: 22.528, lng: 88.365 };
    const queryPoint = {
      type: 'Point',
      coordinates: [center.lng, center.lat], // GeoJSON order [lng, lat]
    };

    // 4 km query: matches Ballygunge (1.16 km) and Jadavpur (3.19 km), excludes Salt Lake (8.44 km)
    const tightZones = await ServiceZone.find({
      centerLocation: {
        $nearSphere: {
          $geometry: queryPoint,
          $maxDistance: 4000,
        },
      },
    }).lean();

    assert.equal(tightZones.length, 2, 'Tight radius (4 km) should return exactly 2 zones');
    assert.ok(tightZones.some((z) => z.code === 'KOL-CENTRAL-BAL'), 'Ballygunge must match');
    assert.ok(tightZones.some((z) => z.code === 'KOL-SOUTH-GP'), 'Jadavpur must match');
    assert.ok(!tightZones.some((z) => z.code === 'KOL-EAST-SL2'), 'Salt Lake must be excluded by 4 km radius');

    // 15 km query: returns all 3 seeded zones in ascending distance order
    const broadZones = await ServiceZone.find({
      centerLocation: {
        $nearSphere: {
          $geometry: queryPoint,
          $maxDistance: 15000,
        },
      },
    }).lean();

    assert.equal(broadZones.length, 3, 'Broad radius (15 km) should return all 3 seeded zones');
    const d0 = haversineDistanceKm(center, {
      lat: broadZones[0].centerLocation.coordinates[1],
      lng: broadZones[0].centerLocation.coordinates[0],
    });
    const d1 = haversineDistanceKm(center, {
      lat: broadZones[1].centerLocation.coordinates[1],
      lng: broadZones[1].centerLocation.coordinates[0],
    });
    const d2 = haversineDistanceKm(center, {
      lat: broadZones[2].centerLocation.coordinates[1],
      lng: broadZones[2].centerLocation.coordinates[0],
    });

    assert.ok(d0 <= d1, 'Results must be sorted ascending by distance (d0 <= d1)');
    assert.ok(d1 <= d2, 'Results must be sorted ascending by distance (d1 <= d2)');
  });

  it('verifies coordinate order [longitude, latitude] in GeoJSON $nearSphere queries', async () => {
    const center = { lat: 22.528, lng: 88.365 };

    // Valid GeoJSON Point: [lng, lat]
    const validPoint = {
      type: 'Point',
      coordinates: [center.lng, center.lat],
    };
    const validMatches = await ServiceZone.find({
      centerLocation: {
        $nearSphere: {
          $geometry: validPoint,
          $maxDistance: 15000,
        },
      },
    }).lean();
    assert.equal(validMatches.length, 3, 'Valid [lng, lat] coordinates must match seeded zones');

    // Reversed coordinates: [lat, lng] = [22.528, 88.365]
    // Point is at 22.528°E, 88.365°N (Arctic ocean, ~7300 km from Kolkata)
    const reversedPoint = {
      type: 'Point',
      coordinates: [center.lat, center.lng],
    };
    const reversedMatches = await ServiceZone.find({
      centerLocation: {
        $nearSphere: {
          $geometry: reversedPoint,
          $maxDistance: 15000,
        },
      },
    }).lean();
    assert.equal(
      reversedMatches.length,
      0,
      'Reversed [lat, lng] coordinates must return 0 Kolkata matches within 15 km'
    );
  });

  it('executes real geospatial $nearSphere query on seeded Kolkata technician profiles', async () => {
    const center = { lat: 22.528, lng: 88.365 };
    const queryPoint = {
      type: 'Point',
      coordinates: [center.lng, center.lat],
    };

    const nearbyTechs = await TechnicianProfile.find({
      baseLocation: {
        $nearSphere: {
          $geometry: queryPoint,
          $maxDistance: 5000, // 5 km
        },
      },
    })
      .populate('userId')
      .lean();

    assert.ok(nearbyTechs.length >= 2, 'At least 2 seeded technicians should be within 5 km');
    assert.ok(nearbyTechs.every((t) => t.userId && t.userId.role === 'technician'));
  });
});

