import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { Booking, PoolMembership, ServicePool, ServiceCategory, TechnicianProfile, User } from '../src/models/index.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { runPoolLockSweep } from '../src/modules/pools/poolWorker.js';

test('customers quote and join privately, dispatch completes the pool, earnings and feedback persist', async t => {
  env.routingProvider = 'mock';
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  t.after(async () => { await disconnectDB(); await db.stop(); });
  await connectDB(db.getUri());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function request(user, path, method = 'GET', body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method, headers: { Authorization: `Bearer ${signAuthToken(user)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }

  const [owner, neighbor, tech] = await User.create(['First', 'Second', 'Technician'].map((name, index) => ({
    name, email: `${name}@test.example`, passwordHash: 'password', role: index === 2 ? 'technician' : 'customer',
  })));
  const category = await ServiceCategory.create({ name: 'AC', slug: 'ac', baseIndividualPrice: 600, estimatedDurationMins: 30, maxPoolSize: 2 });
  await TechnicianProfile.create({ userId: tech._id, serviceCategories: [category._id], approvalStatus: 'approved',
    availabilityStatus: 'available', baseLocation: { type: 'Point', coordinates: [88.351, 22.521] } });
  const payload = {
    serviceCategoryId: category._id, location: { type: 'Point', coordinates: [88.36, 22.52] }, addressText: 'Private residence one',
    timeWindow: { start: new Date(Date.now() + 86400000), end: new Date(Date.now() + 100000000) },
  };
  await request(neighbor, '/users/me', 'PATCH', { poolAlertLocation: { lat: 22.521, lng: 88.36 } });
  const distant = await User.create({ name: 'Distant', email: 'far@test.example', passwordHash: 'password',
    poolAlertLocation: { type: 'Point', coordinates: [88.36, 22.522] } });
  const first = (await request(owner, '/bookings', 'POST', payload, 201)).data;
  const beforeLock = await request(tech, '/technicians/me/opportunities');
  assert.ok(beforeLock.meta.formingPools.some(pool => pool.id === first.poolId._id && pool.members === 1));
  assert.equal(beforeLock.data.length, 0);
  const newPoolNotices = (await request(tech, '/notifications/my')).data;
  assert.ok(newPoolNotices.some(n => n.relatedEntityId === first.poolId._id && n.title === 'New service pool'));
  await runPoolLockSweep({ dispatch: true });
  const afterSweep = (await request(tech, '/notifications/my')).data;
  assert.equal(afterSweep.filter(n => n.relatedEntityId === first.poolId._id).length, 1);
  const notices = (await request(neighbor, '/notifications/my')).data;
  assert.equal(notices.filter(n => n.relatedEntityId === first.poolId._id && n.invitation.serviceCategoryId === String(category._id)).length, 1);
  assert.equal((await request(distant, '/notifications/my')).data.length, 0);
  const farPayload = { ...payload, location: distant.poolAlertLocation };
  assert.deepEqual((await request(distant, '/bookings/quote', 'POST', farPayload)).data.nearbyPools, []);
  await request(distant, '/bookings', 'POST', { ...farPayload, targetPoolId: first.poolId._id }, 409);
  const body = { ...payload, location: { lat: 22.521, lng: 88.36 }, targetPoolId: first.poolId._id, addressText: 'Private residence two' };
  const quote = (await request(neighbor, '/bookings/quote', 'POST', body)).data;
  assert.equal(quote.nearbyPools[0].distanceMeters, 111);
  assert.equal(quote.nearbyPools[0].id, first.poolId._id);
  assert.equal(quote.finalPricePerMember, 540);
  await request(neighbor, '/bookings', 'POST', { ...body, quotedPrice: 500 }, 409);
  assert.equal(await Booking.countDocuments(), 1);
  assert.equal(await PoolMembership.countDocuments(), 1);
  const second = (await request(neighbor, '/bookings', 'POST', { ...body, quotedPrice: 540 }, 201)).data;
  const poolId = second.poolId._id;
  const ownDetails = (await request(owner, `/bookings/${first._id}`)).data;
  assert.equal(ownDetails.estimatedPrice, 540);
  assert.equal(ownDetails.poolId.members, undefined);
  const pool = (await request(owner, `/pools/${poolId}`)).data;
  assert.equal(pool.centroidLocation, undefined);
  const other = pool.members.find(m => !m.isCurrentUser);
  assert.equal(other.approximateAddress, 'Nearby area');
  assert.equal(other.location, undefined);

  const individual = (await request(neighbor, `/bookings/${second._id}`, 'PATCH', { bookingMode: 'individual' })).data;
  assert.equal(individual.estimatedPrice, 600);
  await request(neighbor, `/bookings/${second._id}`, 'PATCH', { bookingMode: 'pool' });
  await runPoolLockSweep({ dispatch: true });
  assert.equal((await ServicePool.findById(poolId)).status, 'locked');
  const opportunities = (await request(tech, '/technicians/me/opportunities')).data;
  assert.equal(opportunities[0].id, poolId);
  assert.equal(opportunities[0].total, 1080);
  assert.ok(opportunities[0].estimate.hourlyRate > 0);
  assert.ok(opportunities[0].estimate.travelMinutes > 0);
  await request(tech, `/technicians/me/opportunities/${poolId}/claim`, 'POST', {kind: 'pool'});
  assert.equal((await ServicePool.findById(poolId)).status, 'assigned');
  await request(tech, `/technicians/me/jobs/${poolId}/accept`, 'POST', {});
  const accepted = await ServicePool.findById(poolId);
  assert.equal(accepted.routeOrder.length, 2);
  const stops = (await request(tech, `/technicians/me/jobs/${poolId}/stops`)).data.stops;
  assert.deepEqual(stops.map(s => s.bookingId), accepted.routeOrder.map(s => String(s.bookingId)));
  const laterCustomer = String(accepted.routeOrder[1].bookingId) === first._id ? owner : neighbor;
  assert.equal((await request(laterCustomer, '/bookings/dashboard')).data.visitsAhead, 1);
  for (const [index, stop] of accepted.routeOrder.entries()) {
    for (const action of ['arrive', 'start', 'complete']) {
      await request(tech, `/technicians/me/jobs/${poolId}/stops/${stop.bookingId}/${action}`, 'POST', {});
      if (index === 0 && action === 'arrive') {
        const before = await ServicePool.findById(poolId).lean();
        await request(tech, `/technicians/me/jobs/${poolId}/route?lat=22.523&lng=88.365`);
        assert.deepEqual((await ServicePool.findById(poolId)).updatedAt, before.updatedAt);
        await request(tech, `/technicians/me/jobs/${poolId}/replan`, 'POST', {});
        const replanned = await ServicePool.findById(poolId);
        assert.equal(String(replanned.routeOrder[0].bookingId), String(stop.bookingId));
        assert.deepEqual(replanned.routeOrder[0].actualArrival, before.routeOrder[0].actualArrival);
      }
    }
    if (!index) assert.equal((await request(laterCustomer, '/bookings/dashboard')).data.visitsAhead, 0);
  }
  const confirmation = (await request(owner, `/bookings/${first._id}/confirm-completion`, 'POST', {})).data;
  assert.deepEqual((await request(owner, `/bookings/${first._id}/confirm-completion`, 'POST', {})).data, confirmation);
  await request(owner, `/bookings/${first._id}/rating`, 'POST', { rating: 5, comment: 'On time' }, 201);
  assert.equal((await request(owner, `/bookings/${first._id}/rating`)).data.rating, 5);
  const earnings = (await request(tech, '/technicians/me/earnings')).data;
  assert.equal(earnings.completedServices, 2);
  assert.equal(earnings.todayPaise, 108000);
  const matches = await request(tech, `/technicians/me/jobs?q=${poolId}&limit=1&status=completed`);
  assert.equal(matches.data[0]._id, poolId);
  assert.equal(matches.meta.counts.completed, 1);
  assert.equal(earnings.incentivePaise, 0);
  assert.equal(earnings.servicePaise, 108000);
  for (let i = 0; i < 5; i++) await request(owner, '/bookings', 'POST', { ...payload, bookingMode: 'individual' }, 201);
  const history = await request(owner, '/bookings/my?summary=true&limit=5');
  assert.equal(history.data.length, 5);
  assert.equal(history.meta.pagination.total, 6);
  assert.equal(history.meta.byStatus.completed, 1);

  await t.test('only the active founder can change the deadline, which survives membership changes and drives locking', async () => {
    const service = await ServiceCategory.create({ name: 'Cutoff test', slug: 'cutoff-test', baseIndividualPrice: 300,
      estimatedDurationMins: 20, maxPoolSize: 4 });
    const input = { ...payload, serviceCategoryId: service.id };
    const booking = (await request(owner, '/bookings', 'POST', input, 201)).data;
    const id = booking.poolId._id;
    const path = `/pools/${id}/lock-cutoff`;
    const edited = new Date(Date.parse(booking.poolId.lockCutoffTime) + 600000);
    const patch = { lockCutoffTime: edited.toISOString() };
    assert.equal((await request(owner, '/pools/' + id)).data.canEditCutoff, true);
    await request(owner, path, 'PATCH', { lockCutoffTime: 'invalid' }, 400);
    await request(owner, path, 'PATCH', { lockCutoffTime: new Date(0) }, 400);
    await request(owner, path, 'PATCH', { lockCutoffTime: payload.timeWindow.end }, 400);
    await request(owner, path, 'PATCH', patch);
    const joined = (await request(neighbor, '/bookings', 'POST', input, 201)).data;
    assert.equal(joined.poolId.lockCutoffTime, patch.lockCutoffTime);
    assert.equal((await request(neighbor, '/pools/' + id)).data.canEditCutoff, false);
    await request(neighbor, path, 'PATCH', patch, 403);
    await request(neighbor, `/bookings/${joined._id}/cancel`, 'PATCH', {});
    await runPoolLockSweep({ now: new Date(booking.poolId.lockCutoffTime) });
    assert.equal((await ServicePool.findById(id)).status, 'forming');
    await runPoolLockSweep({ now: edited });
    assert.equal((await ServicePool.findById(id)).status, 'locked');
    await request(owner, path, 'PATCH', patch, 409);
  });

  await t.test('price watches fire once and closing limits settle cascading cancellations', async () => {
    const service = await ServiceCategory.create({ name: 'Window cleaning', slug: 'window-test', baseIndividualPrice: 600,
      estimatedDurationMins: 30, maxPoolSize: 3 });
    const input = { ...payload, specificService: service.name, serviceCategoryId: service.id };
    const first = (await request(owner, '/bookings', 'POST', { ...input, closingPriceLimit: 500 }, 201)).data;
    const watch = (await request(neighbor, '/bookings/watches', 'POST', { ...input, maxPrice: 540 }, 201)).data;
    await request(distant, '/bookings/watches/' + watch._id, 'DELETE');
    assert.equal((await request(neighbor, '/bookings/watches')).data.length, 1);
    await runPoolLockSweep({ dispatch: true });
    await runPoolLockSweep({ dispatch: true });
    assert.equal((await request(neighbor, '/bookings/watches')).data.length, 0);
    const alerts = (await request(neighbor, '/notifications/my')).data.filter(n => n.invitation?.fromWatch);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].relatedEntityId, first.poolId._id);
    const second = (await request(neighbor, '/bookings', 'POST', { ...input, closingPriceLimit: 550 }, 201)).data;
    const result = await runPoolLockSweep({ now: new Date(first.poolId.lockCutoffTime) });
    assert.ok(result.cancelledCount >= 1);
    for (const id of [first._id, second._id]) {
      const record = await Booking.findById(id);
      assert.equal(record.status, 'cancelled');
      assert.equal(record.poolId, null);
    }
    assert.equal(await PoolMembership.countDocuments({ poolId: first.poolId._id, status: 'active' }), 0);
    // At capacity, the two-member ₹540 price is acceptable at equality.
    const fullService = await ServiceCategory.create({ name: 'Glass cleaning', slug: 'glass-test', baseIndividualPrice: 600,
      estimatedDurationMins: 30, maxPoolSize: 2 });
    const fullInput = { ...input, serviceCategoryId: fullService.id, specificService: fullService.name };
    const retained = (await request(owner, '/bookings', 'POST', { ...fullInput, closingPriceLimit: 540 }, 201)).data;
    await request(neighbor, '/bookings', 'POST', fullInput, 201);
    assert.equal((await Booking.findById(retained._id)).estimatedPrice, 540);
    assert.equal((await ServicePool.findById(retained.poolId._id)).status, 'locked');
  });

  await t.test('manual pools appear across buildings while joining respects distance, queue order and member prices', async () => {
    const plumbing = await ServiceCategory.create({ name: 'Plumbing', slug: 'plumbing', baseIndividualPrice: 500, estimatedDurationMins: 40 });
    const manual = { ...payload, serviceCategoryId: plumbing._id, specificService: 'Tap repair', timeWindow: undefined };
    const near = { lat: 22.5201, lng: 88.36 };
    const at400m = { lat: 22.5236, lng: 88.36 };
    const tower = (await request(owner, '/bookings', 'POST', { ...manual, poolScope: 'building', building: 'Tower A' }, 201)).data;
    assert.equal(tower.poolId.maxCapacity, 10);
    assert.ok(Date.parse(tower.timeWindow.start) > Date.now());
    const visibleTower = (await request(neighbor, '/pools/nearby?lat=22.5236&lng=88.36&radiusKm=0.5')).data.find(p => p.id === tower.poolId._id);
    assert.equal(visibleTower?.canJoinFromLocation, false);
    const join = { ...manual, targetPoolId: tower.poolId._id, location: near };
    await request(neighbor, '/bookings', 'POST', { ...join, building: 'Tower B' }, 409);
    await request(neighbor, '/bookings', 'POST', join, 400);
    const member = (await request(neighbor, '/bookings', 'POST', { ...join, building: ' tower   A ' }, 201)).data;
    assert.equal(member.estimatedPrice, 450);
    assert.equal((await request(neighbor, `/bookings/${member._id}`)).data.visitPosition, 2);
    for (const [scope, capacity] of [['200m',6],['500m',4],['1km',2]]) {
      const booking = (await request(owner, '/bookings', 'POST', { ...manual, poolScope: scope }, 201)).data;
      const poolId = booking.poolId._id;
      assert.equal(booking.poolId.maxCapacity, capacity);
      assert.equal((await request(neighbor, '/pools/nearby?lat=22.5236&lng=88.36')).data.some(p=>p.id===poolId), false);
      const withinSearchRange = (await request(neighbor, '/pools/nearby?lat=22.5236&lng=88.36&radiusKm=0.5')).data.find(p=>p.id===poolId);
      assert.equal(withinSearchRange?.canJoinFromLocation, scope !== '200m');
      const matching = (await request(neighbor, `/pools/nearby?lat=22.5236&lng=88.36&serviceCategoryId=${plumbing._id}&specificService=Tap%20repair`)).data;
      assert.equal(matching.find(p=>p.id===poolId)?.canJoinFromLocation, scope !== '200m');
      const response = await request(neighbor, '/bookings', 'POST', { ...manual, location: at400m, targetPoolId: poolId }, scope==='200m'?409:201);
      if (scope === '1km') {
        assert.equal(response.data.poolId.status, 'locked');
        await request(tech, `/technicians/me/opportunities/${poolId}/claim`, 'POST', {kind:'pool'}, 409);
        await runPoolLockSweep({dispatch:true});
        assert.equal((await request(tech,'/notifications/my')).data.some(n=>n.relatedEntityId===poolId), false);
        await request(tech, '/technicians/me/profile', 'PATCH', {
          serviceCategories: [plumbing._id], baseLocation: { lat: 28.61, lng: 77.21 }, serviceRadiusKm: 1,
        });
        const available = (await request(tech, '/technicians/me/opportunities')).data;
        assert.equal(available.some(job => job.id === poolId), false);
        await request(tech, `/technicians/me/opportunities/${poolId}/claim`, 'POST', {kind:'pool'}, 409);
        await request(tech, '/technicians/me/profile', 'PATCH', { baseLocation: near });
        await runPoolLockSweep({dispatch:true});
        assert.ok((await request(tech,'/notifications/my')).data.some(n=>n.type==='opportunity' && n.relatedEntityId===poolId));
        await request(tech, `/technicians/me/opportunities/${poolId}/claim`, 'POST', {kind:'pool'});
        await request(tech, `/technicians/me/jobs/${poolId}/accept`, 'POST', {});
        const accepted = await ServicePool.findById(poolId);
        assert.deepEqual(accepted.routeOrder.map(s=>String(s.bookingId)), [booking._id, response.data._id]);
      }
    }
    await request(neighbor, '/pools/nearby?lat=22.5236&lng=88.36&radiusKm=2', 'GET', undefined, 400);
  });
});
