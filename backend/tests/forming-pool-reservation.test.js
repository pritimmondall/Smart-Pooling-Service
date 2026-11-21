import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Booking, ServicePool, ServiceCategory, TechnicianProfile, User } from '../src/models/index.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { runPoolLockSweep } from '../src/modules/pools/poolWorker.js';

test('technician reserves a forming pool while customers keep joining, then receives the locked job', async t => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  t.after(async () => { await disconnectDB(); await db.stop(); });
  await connectDB(db.getUri());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function request(user, path, method = 'GET', body, expected = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${signAuthToken(user)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }

  const [owner, neighbor, technician, otherTechnician] = await User.create([
    ['owner', 'customer'], ['neighbor', 'customer'], ['technician', 'technician'], ['other-tech', 'technician'],
  ].map(([name, role]) => ({ name, email: `${name}@reservation.test`, passwordHash: 'password', role })));
  const category = await ServiceCategory.create({
    name: 'Electrical', slug: 'electrical', baseIndividualPrice: 400, estimatedDurationMins: 30,
  });
  for (const tech of [technician, otherTechnician]) {
    await TechnicianProfile.create({ userId: tech._id, serviceCategories: [category._id],
      approvalStatus: 'approved', availabilityStatus: 'available',
      baseLocation: { type: 'Point', coordinates: [77.21, 28.61] } });
  }

  const booking = (await request(owner, '/bookings', 'POST', {
    serviceCategoryId: category._id, specificService: 'Switchboard repair', bookingMode: 'pool', poolScope: '1km',
    location: { lat: 22.52, lng: 88.36 }, addressText: 'Building A',
  }, 201)).data;
  const poolId = booking.poolId._id;
  const opportunities = await request(technician, '/technicians/me/opportunities');
  assert.equal(opportunities.meta.formingPools.find(pool => pool.id === poolId)?.canReserve, true);

  const reservation = await request(technician, `/technicians/me/opportunities/${poolId}/claim`, 'POST', { kind: 'pool' });
  assert.equal(reservation.data.reserved, true);
  const forming = await ServicePool.findById(poolId);
  assert.equal(forming.status, 'forming');
  assert.equal(String(forming.reservedTechnicianId), String(technician._id));
  assert.equal((await request(technician, '/technicians/me/opportunities')).meta.formingPools
    .find(pool => pool.id === poolId)?.reservedByMe, true);
  assert.equal((await request(otherTechnician, '/technicians/me/opportunities')).meta.formingPools
    .some(pool => pool.id === poolId), false);
  await request(otherTechnician, `/technicians/me/opportunities/${poolId}/claim`, 'POST', { kind: 'pool' }, 409);

  const second = (await request(neighbor, '/bookings', 'POST', {
    serviceCategoryId: category._id, bookingMode: 'pool', targetPoolId: poolId,
    location: { lat: 22.521, lng: 88.36 }, addressText: 'Building B',
  }, 201)).data;
  assert.equal(second.poolId.status, 'locked');
  await runPoolLockSweep({ dispatch: true });

  const assigned = await ServicePool.findById(poolId);
  assert.equal(assigned.status, 'assigned');
  assert.equal(String(assigned.assignedTechnicianId), String(technician._id));
  assert.equal(assigned.reservedTechnicianId, null);
  assert.equal((await Booking.findById(booking._id)).status, 'assigned');
  assert.equal((await Booking.findById(second._id)).status, 'assigned');

  const waiting = (await request(owner, '/bookings', 'POST', {
    serviceCategoryId: category._id, specificService: 'Switchboard repair', bookingMode: 'pool', poolScope: '1km',
    location: { lat: 22.52, lng: 88.36 }, addressText: 'Building A',
  }, 201)).data;
  const waitingPoolId = waiting.poolId._id;
  await request(otherTechnician, `/technicians/me/opportunities/${waitingPoolId}/claim`, 'POST', { kind: 'pool' });
  await ServicePool.updateOne({ _id: waitingPoolId }, { $set: { lockCutoffTime: new Date(Date.now() - 1000) } });
  await runPoolLockSweep({ dispatch: true });
  const afterCutoff = await ServicePool.findById(waitingPoolId);
  assert.equal(afterCutoff.status, 'assigned');
  assert.equal(String(afterCutoff.assignedTechnicianId), String(otherTechnician._id));
});
