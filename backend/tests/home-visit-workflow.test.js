import { backfillHomeVisits } from '../src/scripts/migrate-home-visits.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { Booking, PoolMembership, ServicePool, ServiceCategory, TechnicianProfile, User, Notification } from '../src/models/index.js';
import { runPoolLockSweep, dispatchWaitingJobs, startPoolWorker, stopPoolWorker } from '../src/modules/pools/poolWorker.js';
import { setDefaultRoutingProvider } from '../src/modules/routing/routingProvider.factory.js';

test('home visits through customer API, dispatch worker and technician dashboard API', async t => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await connectDB(db.getUri());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await disconnectDB(); await db.stop(); });
  const minute = 60000;
  const initial = Date.parse('2027-01-04T09:00:00+05:30');
  const tomorrow = Date.parse('2027-01-05T10:00:00+05:30');
  t.mock.timers.enable({ apis: ['Date'], now: initial });
  const clock = ms => t.mock.timers.setTime(ms);
  let outage = false;
  setDefaultRoutingProvider({ async getDistanceMatrix(points) {
    if (outage) throw new Error('unreachable');
    const durations = points.map(a => points.map(b => a.lng === b.lng && a.lat === b.lat ? 0 : 600));
    return { durations, distances: durations.map(row => row.map(s => s * 5)), provider: 'mock' };
  } });
  t.after(() => setDefaultRoutingProvider(null));
  const users = await User.create(['Alice', 'Bob', 'Cara', 'Dan'].map(name => ({
    name, role: 'customer', email: name + '@visit.test', passwordHash: 'fixture-password',
  })));
  let serial = 0;
  async function setup(capacity = 3, available = true) {
    clock(initial);
    const name = 'Service ' + ++serial;
    const category = await ServiceCategory.create({ name, slug: 'service-' + serial, estimatedDurationMins: 30,
      baseIndividualPrice: 600, maxPoolSize: capacity });
    const tech = await User.create({ name: 'Tech ' + serial, role: 'technician', email: serial + '@visit.test', passwordHash: 'fixture-password' });
    const profile = await TechnicianProfile.create({ userId: tech._id, serviceCategories: [category._id],
      approvalStatus: 'approved', availabilityStatus: available ? 'available' : 'offline',
      baseLocation: { type: 'Point', coordinates: [88.36, 22.52] } });
    const input = (start = 0, end = 30, offset = 0) => ({ specificService: name, serviceCategoryId: category.id,
      addressText: 'Home ' + offset, location: { lat: 22.52, lng: 88.36 + offset / 10000 },
      timeWindow: { start: new Date(tomorrow + start * minute).toISOString(), end: new Date(tomorrow + end * minute).toISOString() } });
    return { category, tech, profile, input };
  }
  async function request(user, path, method, data, expected) {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + path, { method,
      headers: { Authorization: 'Bearer ' + signAuthToken(user), 'Content-Type': 'application/json' },
      body: data && JSON.stringify(data) });
    const json = await res.json();
    if (expected) assert.equal(res.status, expected, JSON.stringify(json));
    return { status: res.status, ...json };
  }
  const quote = async (user, data) => (await request(user, '/visits/quote', 'POST', data, 200)).data;
  const confirm = (u, input, q, extra, expected) => request(u, '/visits', 'POST', { ...input,
    quoteToken: q.quoteToken, ...extra }, expected);
  const book = async (u, input) => (await confirm(u, input, await quote(u, input), {}, 201)).data;
  const sweep = async () => assert.equal((await runPoolLockSweep({ dispatch: true })).error, undefined);
  const details = async (u, b) => (await request(u, '/bookings/' + b._id, 'GET', undefined, 200)).data;
  const job = b => '/technicians/me/jobs/' + b.poolId._id;

  for (const accepted of [false, true]) await t.test('sequential windows, one hour apart, on ' + (accepted ? 'accepted' : 'assigned') + ' route', async () => {
    const { tech, input } = await setup();
    const first = await book(users[0], input());
    clock(initial + 30000);
    await sweep();
    assert.equal((await details(users[0], first)).technicianId, tech.id);
    if (accepted) await request(tech, job(first) + '/accept', 'POST', {}, 200);
    clock(initial + 60 * minute);
    const secondInput = input(40, 90, 1);
    const q = await quote(users[1], secondInput);
    assert.equal(q.finalPricePerMember, 540);
    assert.equal(q.shiftOffer, null);
    const second = (await confirm(users[1], secondInput, q, {}, 201)).data;
    assert.equal(second.status, accepted ? 'accepted' : 'assigned');
    assert.equal(second.technicianId, tech.id);
    assert.equal(second.poolId._id, first.poolId._id);
    assert.equal(second.confirmedMaxFare, 540);
    assert.deepEqual(second.timeWindow, secondInput.timeWindow);
    const original = await details(users[0], first);
    assert.equal(original.estimatedPrice, 540);
    assert.equal(original.confirmedMaxFare, 600);
    assert.deepEqual(original.timeWindow, input().timeWindow);
    const route = (await request(tech, job(first) + '/stops', 'GET', undefined, 200)).data;
    assert.deepEqual(route.stops.map(s => s.estimatedServiceStart), [input().timeWindow.start, secondInput.timeWindow.start]);
    assert.equal((await confirm(users[1], secondInput, q, {}, 201)).data._id, second._id);
    assert.equal(await PoolMembership.countDocuments({ bookingId: second._id }), 1);
    if (!accepted) return;
    clock(tomorrow - 5 * minute);
    const stop = job(first) + '/stops/' + first._id;
    await request(tech, stop + '/status', 'PATCH', { status: 'on_the_way' }, 200);
    await request(tech, stop + '/arrive', 'POST', {}, 200);
    await request(tech, stop + '/start', 'POST', {}, 200);
    const before = await ServicePool.findById(first.poolId._id).lean();
    const separate = await book(users[2], input(1, 31, 2));
    assert.notEqual(separate.poolId._id, first.poolId._id);
    assert.deepEqual((await ServicePool.findById(before._id).lean()).routeOrder, before.routeOrder);
    await request(tech, stop + '/complete', 'POST', {}, 200);
    const receipt = await details(users[0], first);
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.estimatedPrice, 540);
    await request(users[0], '/bookings/' + first._id + '/rating', 'POST', { rating: 5 }, 201);
  });

  await t.test('shift consent, original option and expired quote', async () => {
    const { input } = await setup();
    const first = await book(users[0], input());
    await sweep();
    const overlapping = input(0, 30, 1);
    const q = await quote(users[1], overlapping);
    assert.equal(q.finalPricePerMember, 600);
    assert.equal(q.shiftOffer.price, 510);
    const original = (await confirm(users[1], overlapping, q, {}, 201)).data;
    assert.notEqual(original.poolId._id, first.poolId._id);
    assert.deepEqual(original.timeWindow, overlapping.timeWindow);
    await request(users[1], '/bookings/' + original._id + '/cancel', 'PATCH', {}, 200);
    const offer = await quote(users[1], overlapping);
    clock(initial + 6 * minute);
    const changed = await confirm(users[1], overlapping, offer, { acceptShift: offer.shiftOffer }, 409);
    const fresh = changed.error.details.quote;
    assert.equal(await Booking.countDocuments({ customerId: users[1]._id, serviceCategoryId: first.serviceCategoryId._id, status: { $ne: 'cancelled' } }), 0);
    const shifted = (await confirm(users[1], overlapping, fresh, { acceptShift: fresh.shiftOffer }, 201)).data;
    assert.deepEqual(shifted.timeWindow, fresh.shiftOffer.timeWindow);
    assert.equal(shifted.estimatedPrice, fresh.shiftOffer.price);
    await book(users[2], input(90, 120, 2));
    assert.equal((await details(users[1], shifted)).estimatedPrice, 480);
  });

  await t.test('unverifiable legs and a following appointment protect the existing route', async () => {
    const { input, tech, category } = await setup();
    const first = await book(users[0], input());
    await sweep();
    const saved = await ServicePool.findById(first.poolId._id).lean();
    await Booking.create({ customerId: users[3]._id, serviceCategoryId: category._id, technicianId: tech._id,
      bookingMode: 'individual', status: 'accepted', estimatedPrice: 600, addressText: 'Next appointment',
      location: { type: 'Point', coordinates: [88.38, 22.52] }, timeWindow: input(75, 105).timeWindow });
    assert.notEqual((await book(users[1], input(40, 70, 1))).poolId._id, first.poolId._id);
    outage = true;
    try {
      const another = await book(users[2], input(120, 180, 2));
      assert.notEqual(another.poolId._id, first.poolId._id);
    } finally { outage = false; }
    assert.deepEqual((await ServicePool.findById(saved._id).lean()).routeOrder, saved.routeOrder);
  });

  await t.test('waiting deadline, restart, decline and retry', async () => {
    const { input, profile, tech } = await setup(3, false);
    const first = await book(users[0], input());
    clock(initial + 4 * minute);
    await book(users[1], input(40, 90, 1));
    await sweep();
    assert.equal((await details(users[0], first)).waiting, false);
    clock(initial + 5 * minute);
    await sweep();
    assert.equal((await details(users[0], first)).waiting, true);
    await sweep();
    assert.equal(await Notification.countDocuments({ relatedEntityId: first._id, title: 'Still looking for a technician' }), 1);
    await TechnicianProfile.updateOne({ _id: profile._id }, { availabilityStatus: 'available' });
    await sweep();
    await sweep();
    assert.equal((await details(users[0], first)).technicianId, tech.id);
    assert.equal(await Notification.countDocuments({ relatedEntityId: first._id, title: 'Technician Assigned' }), 1);
    await request(tech, job(first) + '/accept', 'POST', {}, 200);
    await request(tech, job(first) + '/reject', 'POST', {}, 200);
    await sweep();
    assert.equal((await details(users[0], first)).technicianId, null);
    const alternative = { ...input(200, 240), replaceBookingId: first._id };
    const replacement = await book(users[0], alternative);
    assert.equal((await details(users[0], first)).status, 'cancelled');
    assert.deepEqual(replacement.timeWindow, alternative.timeWindow);
  });

  await t.test('a verified insertion updates the ETA and sends one fare and ETA notice', async () => {
    const { input } = await setup();
    const first = await book(users[0], input(0, 90));
    await sweep();
    const narrow = input(0, 30, 1);
    const q = await quote(users[1], narrow);
    const joined = (await confirm(users[1], narrow, q, {}, 201)).data;
    assert.equal(joined.poolId._id, first.poolId._id);
    await confirm(users[1], narrow, q, {}, 201);
    const original = await details(users[0], first);
    assert.deepEqual(original.timeWindow, input(0, 90).timeWindow);
    assert.equal(original.estimatedStart, input(40, 90).timeWindow.start);
    for (const title of ['Visit fare reduced', 'Visit ETA updated']) {
      assert.equal(await Notification.countDocuments({ relatedEntityId: first._id, title }), 1);
    }
  });

  await t.test('departure fixes the next stop, completion fixes its history', async () => {
    const { input, tech } = await setup();
    const first = await book(users[0], input(60, 90));
    await sweep();
    await request(tech, job(first) + '/accept', 'POST', {}, 200);
    const stop = job(first) + '/stops/' + first._id;
    await request(tech, stop + '/status', 'PATCH', { status: 'on_the_way' }, 200);
    // This would fit only by changing the technician's destination.
    assert.notEqual((await book(users[1], input(10, 40, 1))).poolId._id, first.poolId._id);
    const after = await book(users[2], input(100, 140, 2));
    assert.equal(after.poolId._id, first.poolId._id);
    clock(tomorrow + 60 * minute);
    await request(tech, stop + '/arrive', 'POST', {}, 200);
    await request(tech, stop + '/start', 'POST', {}, 200);
    clock(tomorrow + 90 * minute);
    await request(tech, stop + '/complete', 'POST', {}, 200);
    const previous = await ServicePool.findById(first.poolId._id).lean();
    const later = await book(users[3], input(150, 190, 3));
    assert.equal(later.poolId._id, first.poolId._id);
    assert.deepEqual((await ServicePool.findById(previous._id).lean()).routeOrder[0], previous.routeOrder[0]);
    assert.equal((await details(users[0], first)).estimatedPrice, 540);
    await request(tech, job(first) + '/stops/' + later._id + '/cancel', 'POST', { reason: 'Customer unavailable' }, 200);
    assert.equal(await PoolMembership.countDocuments({ bookingId: later._id, status: 'active' }), 0);
    assert.equal((await ServicePool.findById(previous._id)).pricing.memberCount, 2);
  });

  await t.test('two workers cannot assign overlapping home visits to one technician', async () => {
    const { input, tech, profile } = await setup();
    const first = await book(users[0], input());
    const other = await book(users[1], input(0, 30, 40));
    assert.notEqual(first.poolId._id, other.poolId._id);
    await Promise.all([dispatchWaitingJobs(), dispatchWaitingJobs()]);
    assert.equal(await Booking.countDocuments({ technicianId: tech._id, status: 'assigned' }), 1);
    assert.equal((await TechnicianProfile.findById(profile._id)).activeWorkload, 1);
  });

  await t.test('departure location accounts for preceding jobs and fresh imminent GPS', async () => {
    for (const origin of ['preceding', 'fresh', 'stale']) {
      const { input, tech, profile, category } = await setup();
      const near = { type: 'Point', coordinates: [88.36, 22.52] };
      await TechnicianProfile.updateOne({ _id: profile._id }, { baseLocation: { type: 'Point', coordinates: [88.38, 22.52] },
        currentLocation: near, lastLocationUpdate: new Date(tomorrow - (origin === 'stale' ? 60 : 11) * minute) });
      const backup = await User.create({ name: 'Another technician', role: 'technician', email: origin + '@origin.test', passwordHash: 'fixture-password' });
      await TechnicianProfile.create({ userId: backup._id, approvalStatus: 'approved', availabilityStatus: 'available',
        serviceCategories: [category._id], baseLocation: { type: 'Point', coordinates: [88.361, 22.52] } });
      if (origin === 'preceding') {
        await Booking.create({ customerId: users[3]._id, serviceCategoryId: category._id, technicianId: tech._id,
          bookingMode: 'individual', status: 'accepted', estimatedPrice: 600, addressText: 'Earlier job',
          location: near, timeWindow: input(-45, -5).timeWindow });
      } else clock(tomorrow - 10 * minute);
      const visit = await book(users[0], input());
      await sweep();
      assert.equal((await details(users[0], visit)).technicianId, origin === 'stale' ? backup.id : tech.id);
    }
  });

  await t.test('confirmation wakes dispatch and startup recovers a declined assignment', async () => {
    const { input, tech, category } = await setup();
    startPoolWorker({ intervalMs: 3600000 });
    let first;
    try { first = await book(users[0], input()); }
    finally { await stopPoolWorker(); }
    assert.equal((await details(users[0], first)).technicianId, tech.id);
    await request(tech, job(first) + '/reject', 'POST', {}, 200);
    const replacement = await User.create({ name: 'Replacement', role: 'technician',
      email: 'replacement@visit.test', passwordHash: 'fixture-password' });
    await TechnicianProfile.create({ userId: replacement._id, approvalStatus: 'approved', availabilityStatus: 'available',
      serviceCategories: [category._id], baseLocation: { type: 'Point', coordinates: [88.36, 22.52] } });
    startPoolWorker({ intervalMs: 3600000 });
    await stopPoolWorker();
    assert.equal((await details(users[0], first)).technicianId, replacement.id);
    assert.equal(await Notification.countDocuments({ relatedEntityId: first._id, title: 'Technician Assigned' }), 2);
  });

  await t.test('old cutoff records backfill once and dispatch without closure', async () => {
    const { input, tech } = await setup();
    const visit = await book(users[0], input());
    await Booking.updateOne({ _id: visit._id }, { $unset: { dispatchDueAt: 1, confirmedMaxFare: 1 }, status: 'pending' });
    await ServicePool.updateOne({ _id: visit.poolId._id }, { $unset: { acceptingVisits: 1 }, lockCutoffTime: new Date(tomorrow) });
    assert.deepEqual(await backfillHomeVisits(), { pools: 1, bookings: 1 });
    assert.deepEqual(await backfillHomeVisits(), { pools: 0, bookings: 0 });
    await sweep();
    assert.equal((await details(users[0], visit)).technicianId, tech.id);
    assert.equal((await details(users[0], visit)).confirmedMaxFare, 600);
    assert.equal((await book(users[1], input(40, 90, 1))).poolId._id, visit.poolId._id);
  });

  await t.test('concurrent last slot and cancellation protect membership and fare ceilings', async () => {
    const { input } = await setup(2);
    const first = await book(users[0], input());
    await sweep();
    const next = input(40, 70, 1);
    const competitors = users.slice(1, 3);
    const quotes = await Promise.all(competitors.map(u => quote(u, next)));
    const outcomes = await Promise.all(competitors.map((u, i) => confirm(u, next, quotes[i])));
    assert.deepEqual(outcomes.map(r => r.status).sort(), [201, 409]);
    assert.equal(outcomes.find(r => r.status === 409).error.details.quote.finalPricePerMember, 600);
    const i = outcomes.findIndex(r => r.status === 201);
    const winner = outcomes[i].data;
    assert.equal(await PoolMembership.countDocuments({ poolId: first.poolId._id, status: 'active' }), 2);
    await request(users[0], '/bookings/' + first._id + '/cancel', 'PATCH', {}, 200);
    const remaining = await details(competitors[i], winner);
    assert.equal(remaining.estimatedPrice, 540);
    const pool = await ServicePool.findById(first.poolId._id);
    assert.equal(pool.pricing.poolTotal, 540);
    assert.deepEqual(pool.routeOrder.map(s => String(s.bookingId)), [winner._id]);
    assert.equal(pool.acceptingVisits, true);
    assert.equal((await TechnicianProfile.findOne({ userId: winner.technicianId })).activeWorkload, 1);
    await request(competitors[i], '/bookings/' + winner._id + '/cancel', 'PATCH', {}, 200);
    assert.equal((await TechnicianProfile.findOne({ userId: winner.technicianId })).activeWorkload, 0);
  });
});
