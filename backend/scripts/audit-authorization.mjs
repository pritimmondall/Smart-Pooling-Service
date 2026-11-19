import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const API_BASE = 'http://localhost:5001/api/v1';
const timestamp = Date.now();

const USER_A = {
  name: 'Customer A Audit',
  email: `cust_a_${timestamp}@smartpool.test`,
  phone: '9876543201',
  password: 'Password@123',
};

const USER_B = {
  name: 'Customer B Audit',
  email: `cust_b_${timestamp}@smartpool.test`,
  phone: '9876543202',
  password: 'Password@123',
};

const results = [];
function record(testName, status, httpCode, details) {
  results.push({ testName, status, httpCode, details });
  console.log(`[Auth Audit] ${status} (${httpCode}): ${testName} — ${details}`);
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, data };
}

async function runAudit() {
  console.log('--- STARTING SECTION 2: BOOKING OWNERSHIP & AUTHORIZATION AUDIT ---');

  // 1. Register Customer A
  const regA = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify(USER_A),
  });
  const tokenA = regA.data?.data?.token;
  const userAId = regA.data?.data?.user?._id;

  // 2. Register Customer B
  const regB = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify(USER_B),
  });
  const tokenB = regB.data?.data?.token;
  const userBId = regB.data?.data?.user?._id;

  // Get active service category
  const servicesRes = await request('/services');
  const serviceId = servicesRes.data?.data?.[0]?._id;

  // 3. Customer A creates Booking A
  const createBookingRes = await request('/bookings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({
      serviceCategoryId: serviceId,
      addressText: 'Flat 101, Audit Towers, Kolkata',
      location: { type: 'Point', coordinates: [88.3639, 22.5176] },
      timeWindow: {
        start: '2026-11-25T10:00:00.000Z',
        end: '2026-11-25T12:00:00.000Z',
      },
      bookingMode: 'pool',
      notes: 'Customer A original notes',
    }),
  });

  const bookingAId = createBookingRes.data?.data?._id;
  if (!bookingAId) {
    throw new Error(`Failed to create Booking A: ${JSON.stringify(createBookingRes.data)}`);
  }
  record('Customer A creates Booking A', 'PASS', createBookingRes.status, `Booking A ID: ${bookingAId}`);

  // 4. Customer A accesses own Booking A
  const readOwnRes = await request(`/bookings/${bookingAId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (readOwnRes.status === 200 && readOwnRes.data?.data?._id === bookingAId) {
    record('Customer A reads own Booking A', 'PASS', readOwnRes.status, 'Successfully retrieved booking details');
  } else {
    record('Customer A reads own Booking A', 'FAIL', readOwnRes.status, JSON.stringify(readOwnRes.data));
  }

  // 5. Customer B attempts to read Customer A's Booking A
  const crossReadRes = await request(`/bookings/${bookingAId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  if (crossReadRes.status === 403) {
    record('Customer B cannot read Customer A Booking', 'PASS', crossReadRes.status, `Denied with code: ${crossReadRes.data?.error?.code}`);
  } else {
    record('Customer B cannot read Customer A Booking', 'FAIL', crossReadRes.status, `Expected 403, got ${crossReadRes.status}`);
  }

  // 6. Customer B attempts to update Customer A's Booking A
  const crossUpdateRes = await request(`/bookings/${bookingAId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({
      notes: 'MALICIOUS OVERWRITE BY CUSTOMER B',
      addressText: 'Hacked Address',
    }),
  });
  if (crossUpdateRes.status === 403) {
    record('Customer B cannot update Customer A Booking', 'PASS', crossUpdateRes.status, `Denied with code: ${crossUpdateRes.data?.error?.code}`);
  } else {
    record('Customer B cannot update Customer A Booking', 'FAIL', crossUpdateRes.status, `Expected 403, got ${crossUpdateRes.status}`);
  }

  // Verify Booking A in database was NOT altered
  const verifyUnchangedRes = await request(`/bookings/${bookingAId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (verifyUnchangedRes.data?.data?.notes === 'Customer A original notes') {
    record('Booking A data integrity after update attack', 'PASS', 200, 'Notes and address remained completely intact');
  } else {
    record('Booking A data integrity after update attack', 'FAIL', 200, `Notes were altered: ${verifyUnchangedRes.data?.data?.notes}`);
  }

  // 7. Customer B attempts to cancel Customer A's Booking A
  const crossCancelRes = await request(`/bookings/${bookingAId}/cancel`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  if (crossCancelRes.status === 403) {
    record('Customer B cannot cancel Customer A Booking', 'PASS', crossCancelRes.status, `Denied with code: ${crossCancelRes.data?.error?.code}`);
  } else {
    record('Customer B cannot cancel Customer A Booking', 'FAIL', crossCancelRes.status, `Expected 403, got ${crossCancelRes.status}`);
  }

  // Verify Booking A status remained pending
  const verifyStatusRes = await request(`/bookings/${bookingAId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (verifyStatusRes.data?.data?.status === 'pending') {
    record('Booking A status integrity after cancel attack', 'PASS', 200, 'Status remained pending');
  } else {
    record('Booking A status integrity after cancel attack', 'FAIL', 200, `Status was modified: ${verifyStatusRes.data?.data?.status}`);
  }

  // 8. ID URL Manipulation: access non-existent or other ObjectId
  const fakeId = new mongoose.Types.ObjectId().toString();
  const manipulatedIdRes = await request(`/bookings/${fakeId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (manipulatedIdRes.status === 404) {
    record('Random Booking ID URL manipulation', 'PASS', manipulatedIdRes.status, 'Safely returned 404 BOOKING_NOT_FOUND');
  } else {
    record('Random Booking ID URL manipulation', 'FAIL', manipulatedIdRes.status, `Expected 404, got ${manipulatedIdRes.status}`);
  }

  // 9. Unauthenticated requests blocked
  const unauthListRes = await request('/bookings/my', { method: 'GET' });
  const unauthCreateRes = await request('/bookings', {
    method: 'POST',
    body: JSON.stringify({ serviceCategoryId: serviceId }),
  });
  if (unauthListRes.status === 401 && unauthCreateRes.status === 401) {
    record('Unauthenticated requests blocked', 'PASS', 401, 'Both GET /my and POST /bookings rejected with 401 AUTH_REQUIRED');
  } else {
    record('Unauthenticated requests blocked', 'FAIL', `${unauthListRes.status}/${unauthCreateRes.status}`, 'Expected 401');
  }

  // 10. Inactive user account blocked from operations
  // Connect to DB and deactivate Customer A
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/smartpool');
  await mongoose.connection.collection('users').updateOne(
    { _id: new mongoose.Types.ObjectId(userAId) },
    { $set: { isActive: false } }
  );

  const inactiveOpRes = await request('/bookings/my', {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (inactiveOpRes.status === 403 && inactiveOpRes.data?.error?.code === 'ACCOUNT_INACTIVE') {
    record('Inactive user account blocked from operations', 'PASS', inactiveOpRes.status, 'Rejected with 403 ACCOUNT_INACTIVE');
  } else {
    record('Inactive user account blocked from operations', 'FAIL', inactiveOpRes.status, `Expected 403 ACCOUNT_INACTIVE, got ${JSON.stringify(inactiveOpRes.data)}`);
  }

  // 11. Customer role forbidden from technician endpoints
  const techEndpointRes = await request('/technicians/me', {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  if (techEndpointRes.status === 403 && techEndpointRes.data?.error?.code === 'FORBIDDEN_ROLE') {
    record('Customer forbidden from technician endpoints', 'PASS', techEndpointRes.status, 'GET /technicians/me rejected with 403 FORBIDDEN_ROLE');
  } else {
    record('Customer forbidden from technician endpoints', 'FAIL', techEndpointRes.status, `Expected 403, got ${techEndpointRes.status}`);
  }

  // 12. Customer role forbidden from admin endpoints
  const adminEndpointRes = await request('/bookings', {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  if (adminEndpointRes.status === 403 && adminEndpointRes.data?.error?.code === 'FORBIDDEN_ROLE') {
    record('Customer forbidden from admin endpoints', 'PASS', adminEndpointRes.status, 'Rejected with 403 FORBIDDEN_ROLE');
  } else {
    record('Customer forbidden from admin endpoints', 'FAIL', adminEndpointRes.status, `Expected 403, got ${adminEndpointRes.status}`);
  }

  // 13. Clean up audit records
  await mongoose.connection.collection('users').deleteMany({
    _id: { $in: [new mongoose.Types.ObjectId(userAId), new mongoose.Types.ObjectId(userBId)] },
  });
  await mongoose.connection.collection('bookings').deleteMany({
    _id: new mongoose.Types.ObjectId(bookingAId),
  });
  await mongoose.connection.collection('notifications').deleteMany({
    userId: { $in: [new mongoose.Types.ObjectId(userAId), new mongoose.Types.ObjectId(userBId)] },
  });
  await mongoose.disconnect();

  record('Audit cleanup of test records', 'PASS', 200, 'Customer A, Customer B, and test booking purged successfully');

  console.log('\n--- OWNERSHIP & AUTHORIZATION AUDIT MATRIX ---');
  console.table(results);
}

runAudit().catch(err => {
  console.error('Audit Runner Error:', err);
  process.exit(1);
});
