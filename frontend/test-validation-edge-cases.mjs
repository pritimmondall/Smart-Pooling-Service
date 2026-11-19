import { api, authApi, bookingsApi } from './src/api/client.js';

const results = [];
function recordResult(name, status, details) {
  results.push({ name, status, details });
  console.log(`[Validation Test] ${status}: ${name} — ${details}`);
}

async function runValidationTests() {
  console.log('--- STARTING GEOSPATIAL, BOOKING VALIDATION & SECURITY TESTS ---');

  // Register & login test user
  const timestamp = Date.now();
  const email = `qa_val_${timestamp}@smartpool.test`;
  const regRes = await authApi.register({
    name: 'Validation Test User',
    email,
    phone: '9876543210',
    password: 'Password@123',
  });

  const token = regRes.data.token;
  globalThis.localStorage = {
    getItem: () => token,
    setItem: () => {},
    removeItem: () => {},
  };

  const servicesRes = await api.get('/services');
  const serviceId = servicesRes.data[0]._id;

  // 1. Invalid coordinates rejected (Latitude > 90)
  try {
    await api.post('/bookings', {
      serviceCategoryId: serviceId,
      addressText: 'Invalid Coordinates Test',
      location: { type: 'Point', coordinates: [88.35, 95.0] },
      timeWindow: {
        start: '2026-11-20T10:00:00.000Z',
        end: '2026-11-20T12:00:00.000Z',
      },
    });
    recordResult('Reject Latitude > 90', 'FAIL', 'Expected 400 error but request succeeded');
  } catch (err) {
    if (err.status === 400 || err.message?.includes('Latitude') || err.message?.includes('INVALID_COORDINATES')) {
      recordResult('Reject Latitude > 90', 'PASS', `Rejected with status ${err.status}: ${err.message}`);
    } else {
      recordResult('Reject Latitude > 90', 'FAIL', `Unexpected error: ${err.message}`);
    }
  }

  // 2. Invalid coordinates rejected (Longitude > 180)
  try {
    await api.post('/bookings', {
      serviceCategoryId: serviceId,
      addressText: 'Invalid Coordinates Test',
      location: { type: 'Point', coordinates: [185.0, 22.5] },
      timeWindow: {
        start: '2026-11-20T10:00:00.000Z',
        end: '2026-11-20T12:00:00.000Z',
      },
    });
    recordResult('Reject Longitude > 180', 'FAIL', 'Expected 400 error but request succeeded');
  } catch (err) {
    if (err.status === 400 || err.message?.includes('Longitude') || err.message?.includes('INVALID_COORDINATES')) {
      recordResult('Reject Longitude > 180', 'PASS', `Rejected with status ${err.status}: ${err.message}`);
    } else {
      recordResult('Reject Longitude > 180', 'FAIL', `Unexpected error: ${err.message}`);
    }
  }

  // 3. Past time windows rejected
  try {
    await api.post('/bookings', {
      serviceCategoryId: serviceId,
      addressText: 'Past Window Test',
      location: { type: 'Point', coordinates: [88.3531, 22.5015] },
      timeWindow: {
        start: '2020-01-01T10:00:00.000Z',
        end: '2020-01-01T12:00:00.000Z',
      },
    });
    recordResult('Reject Past Time Window', 'FAIL', 'Expected 400 error but request succeeded');
  } catch (err) {
    if (err.status === 400 || err.message?.includes('future')) {
      recordResult('Reject Past Time Window', 'PASS', `Rejected with status ${err.status}: ${err.message}`);
    } else {
      recordResult('Reject Past Time Window', 'FAIL', `Unexpected error: ${err.message}`);
    }
  }

  // 4. End time earlier than or equal to start time rejected
  try {
    await api.post('/bookings', {
      serviceCategoryId: serviceId,
      addressText: 'Inverted Window Test',
      location: { type: 'Point', coordinates: [88.3531, 22.5015] },
      timeWindow: {
        start: '2026-11-20T14:00:00.000Z',
        end: '2026-11-20T11:00:00.000Z',
      },
    });
    recordResult('Reject End <= Start Time', 'FAIL', 'Expected 400 error but request succeeded');
  } catch (err) {
    if (err.status === 400 || err.message?.includes('strictly after') || err.message?.includes('timeWindow.end')) {
      recordResult('Reject End <= Start Time', 'PASS', `Rejected with status ${err.status}: ${err.message}`);
    } else {
      recordResult('Reject End <= Start Time', 'FAIL', `Unexpected error: ${err.message}`);
    }
  }

  // 5. GeoJSON [lng, lat] order persistence check
  const validBookingRes = await api.post('/bookings', {
    serviceCategoryId: serviceId,
    addressText: 'GeoJSON Verification Test',
    location: { type: 'Point', coordinates: [88.3531, 22.5015] },
    timeWindow: {
      start: '2026-11-21T10:00:00.000Z',
      end: '2026-11-21T12:00:00.000Z',
    },
    notes: 'GeoJSON coordinates check'
  });

  const bCoords = validBookingRes.data.location.coordinates;
  if (bCoords[0] === 88.3531 && bCoords[1] === 22.5015) {
    recordResult('GeoJSON [lng, lat] Order Persistence', 'PASS', `Stored exact coordinates: [${bCoords[0]}, ${bCoords[1]}] (Order: [lng, lat])`);
  } else {
    recordResult('GeoJSON [lng, lat] Order Persistence', 'FAIL', `Unexpected stored order: ${JSON.stringify(bCoords)}`);
  }

  // 6. Security Check: Verify passwordHash is never returned on auth or user endpoints
  const meRes = await authApi.getMe();
  const profileRes = await api.get('/users/me');
  const hasHash = Boolean(
    regRes.data.user?.passwordHash ||
    meRes.data?.passwordHash ||
    profileRes.data?.passwordHash
  );

  if (!hasHash) {
    recordResult('Security: Zero Password Hash Exposure', 'PASS', 'Verified passwordHash is strictly excluded from all user API payloads');
  } else {
    recordResult('Security: Zero Password Hash Exposure', 'FAIL', 'VULNERABILITY: passwordHash found in payload');
  }

  // 7. Role Restrictions Check: Customer cannot invoke admin endpoints
  try {
    await api.post('/zones', {
      name: 'Hacked Zone',
      code: 'HACK-1',
      centerLocation: { type: 'Point', coordinates: [88.35, 22.50] }
    });
    recordResult('RBAC: Customer Forbidden from Admin Actions', 'FAIL', 'Customer was able to create a zone');
  } catch (err) {
    if (err.status === 403 || err.code === 'FORBIDDEN') {
      recordResult('RBAC: Customer Forbidden from Admin Actions', 'PASS', `Correctly denied with status 403 (${err.message})`);
    } else {
      recordResult('RBAC: Customer Forbidden from Admin Actions', 'FAIL', `Unexpected error status ${err.status}: ${err.message}`);
    }
  }

  console.log('\n--- VALIDATION & SECURITY TEST RESULTS ---');
  console.table(results);
}

runValidationTests();
