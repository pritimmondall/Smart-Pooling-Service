/**
 * Final Phase 2 Verification Script — MongoDB Atlas Integration
 *
 * Verifies:
 * 1. Atlas database connectivity & Replica Set transaction support
 * 2. Real database indexes in Atlas (2dsphere, unique, compound)
 * 3. Actual CRUD persistence for all 6 models:
 *    Users, ServiceCategories, ServiceZones, TechnicianProfiles, Bookings, Notifications
 * 4. Atomic technician registration inside a real ACID transaction
 * 5. Forced failure during technician registration and proof of User rollback
 * 6. Real geospatial $nearSphere queries on seeded Kolkata locations
 * 7. Radius filtering ($maxDistance) and coordinate order ([lng, lat]) validation
 *
 * All test records use identifiable test markers and are cleaned up at completion.
 * No credentials or connection secrets are exposed in logs.
 */

import mongoose from 'mongoose';
import { validateEnv } from '../config/env.js';
import { connectDB, disconnectDB, getDbStatus, runInTransaction } from '../config/db.js';
import {
  User,
  ServiceCategory,
  ServiceZone,
  TechnicianProfile,
  Booking,
  Notification,
} from '../models/index.js';
import { toGeoJSONPoint, haversineDistanceKm } from '../utils/geo.js';

const TEST_TAG = `__VERIFY_TEST_${Date.now()}__`;

const results = {
  dbStatus: null,
  indexes: {},
  crud: {},
  transactionCommit: {},
  transactionRollback: {},
  geospatialQueries: {},
};

async function cleanupAnyLeftovers() {
  await User.deleteMany({ email: { $regex: /__verify_test_/i } });
  await ServiceCategory.deleteMany({ slug: { $regex: /__verify_test_/i } });
  await ServiceZone.deleteMany({ code: { $regex: /__VERIFY_TEST_/i } });
  await Booking.deleteMany({ notes: { $regex: /__VERIFY_TEST_/i } });
  await Notification.deleteMany({ title: { $regex: /__VERIFY_TEST_/i } });
}

async function verifyIndexes() {
  console.log('\n--- [1/6] Verifying Actual Atlas Database Indexes ---');
  const db = mongoose.connection.db;

  const expectedIndexes = {
    users: [
      { name: 'email_1', unique: true, key: { email: 1 } },
      { name: 'role_1', key: { role: 1 } },
    ],
    servicecategories: [
      { name: 'slug_1', unique: true, key: { slug: 1 } },
      { name: 'isActive_1', key: { isActive: 1 } },
    ],
    servicezones: [
      { name: 'code_1', unique: true, key: { code: 1 } },
      { name: 'centerLocation_2dsphere', key: { centerLocation: '2dsphere' } },
    ],
    technicianprofiles: [
      { name: 'userId_1', unique: true, key: { userId: 1 } },
      { name: 'baseLocation_2dsphere', key: { baseLocation: '2dsphere' } },
      {
        name: 'availabilityStatus_1_approvalStatus_1',
        key: { availabilityStatus: 1, approvalStatus: 1 },
      },
    ],
    bookings: [
      { name: 'location_2dsphere', key: { location: '2dsphere' } },
      {
        name: 'status_1_serviceCategoryId_1_timeWindow.start_1',
        key: { status: 1, serviceCategoryId: 1, 'timeWindow.start': 1 },
      },
      { name: 'customerId_1_createdAt_-1', key: { customerId: 1, createdAt: -1 } },
    ],
    notifications: [
      {
        name: 'userId_1_isRead_1_createdAt_-1',
        key: { userId: 1, isRead: 1, createdAt: -1 },
      },
    ],
  };

  for (const [collName, expectedList] of Object.entries(expectedIndexes)) {
    const col = db.collection(collName);
    const existing = await col.indexes();
    results.indexes[collName] = {
      actualIndexNames: existing.map((idx) => idx.name),
      verified: [],
    };

    for (const exp of expectedList) {
      const found = existing.find((idx) => idx.name === exp.name);
      if (!found) {
        throw new Error(`Missing expected index "${exp.name}" on collection "${collName}"`);
      }
      if (exp.unique && !found.unique) {
        throw new Error(`Expected index "${exp.name}" on "${collName}" to be unique`);
      }
      results.indexes[collName].verified.push({
        name: exp.name,
        key: found.key,
        unique: Boolean(found.unique),
        is2dsphere: Object.values(found.key).includes('2dsphere'),
      });
      console.log(`  ✔ Verified index on ${collName}: ${exp.name} (key: ${JSON.stringify(found.key)})`);
    }
  }
}

async function verifyCRUD() {
  console.log('\n--- [2/6] Verifying Real Atlas CRUD Persistence for 6 Models ---');

  // 1. User
  console.log('  Testing User CRUD...');
  const userEmail = `user_${TEST_TAG.toLowerCase()}@test.smartpool.local`;
  const user = await User.create({
    name: 'CRUD Test User',
    email: userEmail,
    phone: '+91-9876543210',
    passwordHash: 'ValidPassword123!',
    role: 'customer',
  });
  const readUser = await User.findById(user._id);
  if (!readUser || readUser.name !== 'CRUD Test User') throw new Error('User read failed');
  readUser.name = 'Updated CRUD Test User';
  await readUser.save();
  const updatedUser = await User.findById(user._id);
  if (updatedUser.name !== 'Updated CRUD Test User') throw new Error('User update failed');
  await User.deleteOne({ _id: user._id });
  const deletedUser = await User.findById(user._id);
  if (deletedUser !== null) throw new Error('User deletion failed');
  results.crud.User = 'PASSED (Create, Read, Update, Delete verified in Atlas)';
  console.log('  ✔ User CRUD passed');

  // 2. ServiceCategory
  console.log('  Testing ServiceCategory CRUD...');
  const catSlug = `cat-${TEST_TAG.toLowerCase().replace(/_/g, '-')}`;
  const cat = await ServiceCategory.create({
    name: 'CRUD Category',
    slug: catSlug,
    description: 'Category for Atlas CRUD verification',
    baseIndividualPrice: 500,
    estimatedDurationMins: 45,
    defaultPoolRadiusKm: 2,
    maxPoolSize: 4,
    poolLockCutoffMins: 60,
  });
  const readCat = await ServiceCategory.findById(cat._id);
  if (!readCat || readCat.slug !== catSlug) throw new Error('ServiceCategory read failed');
  readCat.baseIndividualPrice = 550;
  await readCat.save();
  const updatedCat = await ServiceCategory.findById(cat._id);
  if (updatedCat.baseIndividualPrice !== 550) throw new Error('ServiceCategory update failed');
  await ServiceCategory.deleteOne({ _id: cat._id });
  const deletedCat = await ServiceCategory.findById(cat._id);
  if (deletedCat !== null) throw new Error('ServiceCategory deletion failed');
  results.crud.ServiceCategory = 'PASSED (Create, Read, Update, Delete verified in Atlas)';
  console.log('  ✔ ServiceCategory CRUD passed');

  // 3. ServiceZone
  console.log('  Testing ServiceZone CRUD...');
  const zoneCode = `ZONE-${TEST_TAG.replace(/[^A-Z0-9]/g, '')}`;
  const zone = await ServiceZone.create({
    name: 'CRUD Test Zone',
    code: zoneCode,
    city: 'Kolkata',
    centerLocation: toGeoJSONPoint(22.5726, 88.3639),
    radiusKm: 3.5,
  });
  const readZone = await ServiceZone.findById(zone._id);
  if (!readZone || readZone.code !== zoneCode) throw new Error('ServiceZone read failed');
  readZone.radiusKm = 4.0;
  await readZone.save();
  const updatedZone = await ServiceZone.findById(zone._id);
  if (updatedZone.radiusKm !== 4.0) throw new Error('ServiceZone update failed');
  await ServiceZone.deleteOne({ _id: zone._id });
  const deletedZone = await ServiceZone.findById(zone._id);
  if (deletedZone !== null) throw new Error('ServiceZone deletion failed');
  results.crud.ServiceZone = 'PASSED (Create, Read, Update, Delete verified in Atlas)';
  console.log('  ✔ ServiceZone CRUD passed');

  // 4. TechnicianProfile
  console.log('  Testing TechnicianProfile CRUD...');
  const techUser = await User.create({
    name: 'CRUD Tech User',
    email: `tech_${TEST_TAG.toLowerCase()}@test.smartpool.local`,
    phone: '+91-9876543211',
    passwordHash: 'ValidPassword123!',
    role: 'technician',
  });
  const techProfile = await TechnicianProfile.create({
    userId: techUser._id,
    baseLocation: toGeoJSONPoint(22.5300, 88.3700),
    addressText: 'Kolkata Test Address',
    serviceRadiusKm: 8,
    maxPoolCapacity: 4,
    availabilityStatus: 'offline',
    approvalStatus: 'pending',
  });
  const readTech = await TechnicianProfile.findById(techProfile._id);
  if (!readTech || String(readTech.userId) !== String(techUser._id)) throw new Error('TechnicianProfile read failed');
  readTech.availabilityStatus = 'available';
  await readTech.save();
  const updatedTech = await TechnicianProfile.findById(techProfile._id);
  if (updatedTech.availabilityStatus !== 'available') throw new Error('TechnicianProfile update failed');
  await TechnicianProfile.deleteOne({ _id: techProfile._id });
  await User.deleteOne({ _id: techUser._id });
  const deletedTech = await TechnicianProfile.findById(techProfile._id);
  if (deletedTech !== null) throw new Error('TechnicianProfile deletion failed');
  results.crud.TechnicianProfile = 'PASSED (Create, Read, Update, Delete verified in Atlas)';
  console.log('  ✔ TechnicianProfile CRUD passed');

  // 5. Booking
  console.log('  Testing Booking CRUD...');
  const custUser = await User.create({
    name: 'CRUD Booking Customer',
    email: `cust_${TEST_TAG.toLowerCase()}@test.smartpool.local`,
    phone: '+91-9876543212',
    passwordHash: 'ValidPassword123!',
    role: 'customer',
  });
  const seededCat = await ServiceCategory.findOne({ isActive: true });
  if (!seededCat) throw new Error('Seeded ServiceCategory not found for booking CRUD test');

  const now = new Date();
  const startTime = new Date(now.getTime() + 2 * 3600 * 1000);
  const endTime = new Date(now.getTime() + 4 * 3600 * 1000);

  const booking = await Booking.create({
    customerId: custUser._id,
    serviceCategoryId: seededCat._id,
    location: toGeoJSONPoint(22.5200, 88.3650),
    addressText: 'Test Street, Ballygunge',
    timeWindow: {
      start: startTime,
      end: endTime,
    },
    bookingMode: 'pool',
    status: 'pending',
    estimatedPrice: 600,
    notes: `${TEST_TAG} CRUD Booking Note`,
  });
  const readBooking = await Booking.findById(booking._id);
  if (!readBooking || readBooking.notes !== `${TEST_TAG} CRUD Booking Note`) throw new Error('Booking read failed');
  readBooking.status = 'confirmed';
  await readBooking.save();
  const updatedBooking = await Booking.findById(booking._id);
  if (updatedBooking.status !== 'confirmed') throw new Error('Booking update failed');
  await Booking.deleteOne({ _id: booking._id });
  await User.deleteOne({ _id: custUser._id });
  const deletedBooking = await Booking.findById(booking._id);
  if (deletedBooking !== null) throw new Error('Booking deletion failed');
  results.crud.Booking = 'PASSED (Create, Read, Update, Delete verified in Atlas)';
  console.log('  ✔ Booking CRUD passed');

  // 6. Notification
  console.log('  Testing Notification CRUD...');
  const notifUser = await User.create({
    name: 'CRUD Notification User',
    email: `notif_${TEST_TAG.toLowerCase()}@test.smartpool.local`,
    phone: '+91-9876543213',
    passwordHash: 'ValidPassword123!',
    role: 'customer',
  });
  const notif = await Notification.create({
    userId: notifUser._id,
    role: 'customer',
    title: `${TEST_TAG} Test Notification`,
    message: 'Test notification body content.',
    type: 'system',
    isRead: false,
  });
  const readNotif = await Notification.findById(notif._id);
  if (!readNotif || readNotif.title !== `${TEST_TAG} Test Notification`) throw new Error('Notification read failed');
  readNotif.isRead = true;
  await readNotif.save();
  const updatedNotif = await Notification.findById(notif._id);
  if (updatedNotif.isRead !== true) throw new Error('Notification update failed');
  await Notification.deleteOne({ _id: notif._id });
  await User.deleteOne({ _id: notifUser._id });
  const deletedNotif = await Notification.findById(notif._id);
  if (deletedNotif !== null) throw new Error('Notification deletion failed');
  results.crud.Notification = 'PASSED (Create, Read, Update, Delete verified in Atlas)';
  console.log('  ✔ Notification CRUD passed');
}

async function verifyAtomicTechnicianRegistration() {
  console.log('\n--- [3/6] Verifying Technician Registration inside Real ACID Transaction ---');
  const techEmail = `tx_success_tech_${TEST_TAG.toLowerCase()}@test.smartpool.local`;

  let createdUserId = null;
  let createdProfileId = null;

  const result = await runInTransaction(async (session) => {
    const [user] = await User.create(
      [
        {
          name: 'Tx Test Technician',
          email: techEmail,
          phone: '+91-9999900001',
          passwordHash: 'TxSecret123!',
          role: 'technician',
        },
      ],
      { session }
    );
    createdUserId = user._id;

    const [profile] = await TechnicianProfile.create(
      [
        {
          userId: user._id,
          baseLocation: toGeoJSONPoint(22.518, 88.365),
          addressText: 'Ballygunge Circular Road, Kolkata',
          serviceRadiusKm: 5,
          maxPoolCapacity: 4,
          availabilityStatus: 'offline',
          approvalStatus: 'pending',
        },
      ],
      { session }
    );
    createdProfileId = profile._id;

    return { user, profile };
  });

  // Verify in Atlas outside transaction session
  const persistedUser = await User.findById(createdUserId);
  const persistedProfile = await TechnicianProfile.findById(createdProfileId);

  if (!persistedUser) throw new Error('User was not committed in transaction');
  if (!persistedProfile) throw new Error('TechnicianProfile was not committed in transaction');
  if (String(persistedProfile.userId) !== String(persistedUser._id)) {
    throw new Error('TechnicianProfile.userId does not match User._id');
  }

  results.transactionCommit = {
    status: 'PASSED',
    userId: String(persistedUser._id),
    profileId: String(persistedProfile._id),
    email: persistedUser.email,
    verifiedInAtlas: true,
  };
  console.log(`  ✔ Committed User (${persistedUser._id}) and Profile (${persistedProfile._id}) in Atlas`);

  // Clean up
  await TechnicianProfile.deleteOne({ _id: createdProfileId });
  await User.deleteOne({ _id: createdUserId });
}

async function verifyForcedFailureRollback() {
  console.log('\n--- [4/6] Verifying Forced TechnicianProfile Failure & User Rollback ---');
  const rollbackEmail = `tx_rollback_tech_${TEST_TAG.toLowerCase()}@test.smartpool.local`;

  let capturedUserId = null;
  let transactionError = null;

  try {
    await runInTransaction(async (session) => {
      const [user] = await User.create(
        [
          {
            name: 'Rollback Tech Candidate',
            email: rollbackEmail,
            phone: '+91-9999900002',
            passwordHash: 'TxSecret123!',
            role: 'technician',
          },
        ],
        { session }
      );
      capturedUserId = user._id;
      console.log(`  User created inside transaction session (temp ID: ${capturedUserId})`);

      // Intentionally force an error before committing
      throw new Error('INTENTIONAL_SIMULATED_FAILURE_AFTER_USER_CREATE');
    });
  } catch (err) {
    transactionError = err.message;
    console.log(`  Caught intentional transaction abort error: "${err.message}"`);
  }

  if (transactionError !== 'INTENTIONAL_SIMULATED_FAILURE_AFTER_USER_CREATE') {
    throw new Error(`Unexpected error thrown during transaction: ${transactionError}`);
  }

  // Now query Atlas directly to prove User document was ROLLED BACK
  const userCheck = await User.findOne({ email: rollbackEmail });
  const userByIdCheck = capturedUserId ? await User.findById(capturedUserId) : null;
  const profileCheck = capturedUserId ? await TechnicianProfile.findOne({ userId: capturedUserId }) : null;

  if (userCheck !== null || userByIdCheck !== null) {
    throw new Error('FAIL: User was found in Atlas! Rollback did not work.');
  }
  if (profileCheck !== null) {
    throw new Error('FAIL: TechnicianProfile was found in Atlas! Rollback did not work.');
  }

  results.transactionRollback = {
    status: 'PASSED',
    abortedWith: transactionError,
    uncommittedUserId: String(capturedUserId),
    verifiedUserDeletedInAtlas: userCheck === null && userByIdCheck === null,
    verifiedProfileAbsentInAtlas: profileCheck === null,
  };
  console.log(`  ✔ Verified in Atlas: User ${capturedUserId} was rolled back and does NOT exist in database`);
}

async function verifyGeospatialQueries() {
  console.log('\n--- [5/6] Verifying Real Geospatial $nearSphere Queries against Seeded Kolkata Data ---');

  // Seeded zones:
  // Green Park / Jadavpur: lat 22.5015, lng 88.3531
  // Ballygunge: lat 22.5176, lng 88.3639
  // Salt Lake Sector II: lat 22.5867, lng 88.4171

  // Query origin: Ballygunge Phari (lat: 22.5280, lng: 88.3650)
  // Coordinates in GeoJSON order: [lng, lat] -> [88.3650, 22.5280]
  const queryCenter = { lat: 22.528, lng: 88.365 };
  const queryGeoJSONPoint = {
    type: 'Point',
    coordinates: [queryCenter.lng, queryCenter.lat],
  };

  console.log(`  Query Center: lat ${queryCenter.lat}, lng ${queryCenter.lng} ([lng, lat]: [${queryCenter.lng}, ${queryCenter.lat}])`);

  // Query 1: Tight radius of 4 km (4000 meters)
  // Expected: Ballygunge (dist ~1.16 km) and Jadavpur (dist ~3.17 km) are within 4 km.
  // Salt Lake Sector II (dist ~8.4 km) is EXCLUDED.
  const tightRadiusMeters = 4000;
  const tightResults = await ServiceZone.find({
    centerLocation: {
      $nearSphere: {
        $geometry: queryGeoJSONPoint,
        $maxDistance: tightRadiusMeters,
      },
    },
  }).lean();

  console.log(`\n  Query 1: Radius = ${tightRadiusMeters / 1000} km ($maxDistance: ${tightRadiusMeters})`);
  console.log(`  Results count: ${tightResults.length}`);

  const tightAnalysis = tightResults.map((z) => {
    const [zLng, zLat] = z.centerLocation.coordinates;
    const distanceKm = haversineDistanceKm(queryCenter, { lat: zLat, lng: zLng });
    console.log(`    - ${z.name} (${z.code}): distance = ${distanceKm.toFixed(3)} km, coords: [${zLng}, ${zLat}]`);
    return { name: z.name, code: z.code, distanceKm, coords: [zLng, zLat] };
  });

  const saltLakeInTight = tightResults.some((z) => z.code === 'KOL-EAST-SL2');
  if (saltLakeInTight) {
    throw new Error('Geospatial radius filter failed: Salt Lake (8.4 km away) was returned in 4 km radius query!');
  }
  if (tightResults.length !== 2) {
    throw new Error(`Expected exactly 2 zones within 4 km of query origin, got ${tightResults.length}`);
  }

  // Query 2: Broad radius of 15 km (15000 meters)
  // Expected: All 3 seeded zones returned, in strictly ASCENDING order of spherical distance.
  const broadRadiusMeters = 15000;
  const broadResults = await ServiceZone.find({
    centerLocation: {
      $nearSphere: {
        $geometry: queryGeoJSONPoint,
        $maxDistance: broadRadiusMeters,
      },
    },
  }).lean();

  console.log(`\n  Query 2: Radius = ${broadRadiusMeters / 1000} km ($maxDistance: ${broadRadiusMeters})`);
  console.log(`  Results count: ${broadResults.length}`);

  const broadAnalysis = broadResults.map((z) => {
    const [zLng, zLat] = z.centerLocation.coordinates;
    const distanceKm = haversineDistanceKm(queryCenter, { lat: zLat, lng: zLng });
    console.log(`    - ${z.name} (${z.code}): distance = ${distanceKm.toFixed(3)} km, coords: [${zLng}, ${zLat}]`);
    return { name: z.name, code: z.code, distanceKm, coords: [zLng, zLat] };
  });

  if (broadResults.length !== 3) {
    throw new Error(`Expected all 3 seeded zones within 15 km of query origin, got ${broadResults.length}`);
  }

  // Verify distance ordering is strictly non-decreasing
  for (let i = 0; i < broadAnalysis.length - 1; i++) {
    if (broadAnalysis[i].distanceKm > broadAnalysis[i + 1].distanceKm) {
      throw new Error(`Results are not in ascending distance order: ${broadAnalysis[i].name} (${broadAnalysis[i].distanceKm} km) > ${broadAnalysis[i + 1].name} (${broadAnalysis[i + 1].distanceKm} km)`);
    }
  }

  // Query 3: TechnicianProfiles $nearSphere query
  console.log('\n  Query 3: TechnicianProfiles $nearSphere query within 5 km');
  const techResults = await TechnicianProfile.find({
    baseLocation: {
      $nearSphere: {
        $geometry: queryGeoJSONPoint,
        $maxDistance: 5000,
      },
    },
  }).populate('userId').lean();

  console.log(`  Technicians found within 5 km: ${techResults.length}`);
  for (const tp of techResults) {
    const [tLng, tLat] = tp.baseLocation.coordinates;
    const distanceKm = haversineDistanceKm(queryCenter, { lat: tLat, lng: tLng });
    console.log(`    - Tech User: ${tp.userId?.name} (${tp.addressText}), distance: ${distanceKm.toFixed(3)} km, coords: [${tLng}, ${tLat}]`);
  }

  // Query 4: Coordinate order validation
  console.log('\n  Query 4: Coordinate order test ([lat, lng] vs [lng, lat])');
  // In GeoJSON, passing coordinates with lat > 90 in the second position (or invalid lng/lat) causes MongoDB error.
  // When coordinates are [88.365, 22.528], lng=88.365, lat=22.528 (valid).
  // If coordinates were reversed to [22.528, 88.365], the query would search at 22.528° East, 88.365° North (near the Arctic!),
  // where distance to Kolkata is ~7300 km, resulting in 0 matches within 15 km.
  const reversedGeoJSONPoint = {
    type: 'Point',
    coordinates: [queryCenter.lat, queryCenter.lng], // reversed: [22.528, 88.365]
  };
  const reversedResults = await ServiceZone.find({
    centerLocation: {
      $nearSphere: {
        $geometry: reversedGeoJSONPoint,
        $maxDistance: 15000,
      },
    },
  }).lean();
  console.log(`  Reversed coordinates query returned ${reversedResults.length} results (expected 0 because point is in the Arctic, not Kolkata)`);
  if (reversedResults.length !== 0) {
    throw new Error('Reversed coordinate query unexpectedly matched Kolkata zones!');
  }

  results.geospatialQueries = {
    queryCenter,
    tightQuery: {
      radiusMeters: tightRadiusMeters,
      matchedCount: tightResults.length,
      matchedZones: tightAnalysis,
      excludedZone: 'KOL-EAST-SL2 (Salt Lake Sector II)',
    },
    broadQuery: {
      radiusMeters: broadRadiusMeters,
      matchedCount: broadResults.length,
      matchedZones: broadAnalysis,
      ascendingOrderVerified: true,
    },
    technicianQuery: {
      radiusMeters: 5000,
      matchedCount: techResults.length,
    },
    coordinateOrderCheck: {
      correctGeoJSONCoordinates: queryGeoJSONPoint.coordinates,
      reversedCoordinatesReturnedZero: reversedResults.length === 0,
      confirmedLongitudeFirst: true,
    },
  };
}

async function run() {
  try {
    validateEnv();
    await connectDB();
    results.dbStatus = getDbStatus();
    console.log('MongoDB Connection Status:', results.dbStatus);

    await cleanupAnyLeftovers();
    await verifyIndexes();
    await verifyCRUD();
    await verifyAtomicTechnicianRegistration();
    await verifyForcedFailureRollback();
    await verifyGeospatialQueries();
    await cleanupAnyLeftovers();

    console.log('\n======================================================');
    console.log('✅ ALL MONGODB ATLAS VERIFICATION CHECKS PASSED');
    console.log('======================================================\n');
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('\n❌ VERIFICATION FAILED:', error);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
}

run();

