import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { Booking, User, ServiceCategory, ServicePool } from '../src/models/index.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { runPoolLockSweep } from '../src/modules/pools/poolWorker.js';
import { MockRoadRoutingProvider } from '../src/modules/routing/providers/mockRoadRoutingProvider.js';

const point = lng => ({ lat: 22.52, lng });
const clock = date => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date(date));

function permutations(values) {
  if (!values.length) return [[]];
  return values.flatMap(i => permutations(values.filter(j => j !== i)).map(rest => [i, ...rest]));
}

test('ten customer visits across five technician specialties', async t => {
  env.routingProvider = 'mock';
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  t.after(async () => { await disconnectDB(); await db.stop(); });
  await connectDB(db.getUri());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function api(path, method, token, body) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, path + ' ' + JSON.stringify(result.error));
    return result.data;
  }

  const admin = signAuthToken(await User.create({ name: 'Test administrator', email: 'admin@example.test', passwordHash: randomUUID(), role: 'admin' }));
  const categories = await ServiceCategory.create([
    ['AC service', 'ac-service', 600], ['Appliances', 'appliance-repair', 700],
    ['Electrical', 'electrical', 500], ['Plumbing', 'plumbing', 400], ['Cleaning', 'home-cleaning', 800],
  ].map(([name, slug, baseIndividualPrice]) => ({ name, slug, baseIndividualPrice, estimatedDurationMins: 30, maxPoolSize: 4 })));
  const service = ['AC service', 'Fridge repair', 'Switchboard repair', 'Tap repair', 'Bathroom cleaning'];
  async function register(name, role, extra) {
    return api('/auth/register', 'POST', null, { name, role, email: name + '@example.test', password: randomUUID(), ...extra });
  }
  const techs = [];
  for (const [name, skills, lng, start, end] of [
    ['T1', [0], 88.355, '09:00', '18:00'], ['T2', [1, 0], 88.390, '09:00', '18:00'],
    ['T3', [2, 0], 88.360, '13:00', '15:00'], ['T4', [3], 88.365, '09:00', '18:00'],
    ['T5', [4], 88.382, '09:00', '18:00'],
  ]) {
    const base = point(lng);
    const account = await register(name, 'technician', { baseLocation: base, serviceCategories: skills.map(i => categories[i].id), serviceRadiusKm: 10 });
    await api('/technicians/' + account.technicianProfile._id + '/approval', 'PATCH', admin, { approvalStatus: 'approved' });
    await api('/technicians/me/availability', 'PATCH', account.token, { availabilityStatus: 'available', workingHours: { start, end, daysOfWeek: [1] } });
    techs.push({ ...account, base });
  }
  const day = new Date(Date.now() + 2 * 86400000);
  day.setUTCDate(day.getUTCDate() + (8 - day.getUTCDay()) % 7);
  day.setUTCHours(0, 0, 0, 0);
  const at = hour => new Date(+day + (hour - 5.5) * 3600000);
  t.diagnostic('Service day ' + day.toISOString().slice(0, 10) + ' (IST)');
  const visits = [];
  for (const [category, lng, start, end, shift] of [
    [0, 88.3608, 10, 10.5], [0, 88.3595, 10.6, 11.5], [0, 88.3601, 10, 10.5, true],
    [3, 88.3608, 10, 13], [3, 88.3602, 10.5, 13],
    [0, 88.3904, 10, 13], [0, 88.367, 16, 18],
    [2, 88.3608, 13, 15], [1, 88.3904, 14, 16], [4, 88.38, 10, 13],
  ]) {
    const name = 'C' + (visits.length + 1);
    const account = await register(name, 'customer');
    const location = point(lng);
    const input = { serviceCategoryId: categories[category].id, specificService: service[category],
      location, addressText: name + ' test home', timeWindow: { start: at(start), end: at(end) } };
    if (!visits.length) {
      await assert.rejects(api('/visits', 'POST', account.token, { ...input, bookingMode: 'individual' }), /INVALID_VISIT_FIELD/);
    }
    const quote = await api('/visits/quote', 'POST', account.token, input);
    assert.equal(quote.nearbyPools, undefined);
    if (shift) assert.ok(quote.shiftOffer);
    const booking = await api('/visits', 'POST', account.token, { ...input, quoteToken: quote.quoteToken,
      quotedPrice: shift ? quote.shiftOffer.price : quote.finalPricePerMember, ...(shift && { acceptShift: quote.shiftOffer }) });
    if (shift) assert.equal(booking.timeWindow.start, quote.shiftOffer.timeWindow.start);
    else assert.equal(booking.timeWindow.start, at(start).toISOString());
    visits.push({ name, account, location, id: booking._id, pool: booking.poolId._id, window: booking.timeWindow });
    t.diagnostic([name, service[category], lng, clock(at(start)) + '–' + clock(at(end)), clock(booking.timeWindow.start) + '–' + clock(booking.timeWindow.end)].join(' | '));
  }
  assert.equal(await User.countDocuments({ role: 'customer' }), 10);
  assert.equal(await User.countDocuments({ role: 'technician' }), 5);
  assert.equal(await ServicePool.countDocuments(), 7);
  assert.equal(await Booking.countDocuments({ technicianId: { $ne: null } }), 0);
  const forming = await ServicePool.find().sort({ createdAt: 1 });
  // Legacy cutoffs do not postpone dispatch or close automatic admission.
  await ServicePool.updateOne({ _id: forming[0]._id }, { lockCutoffTime: day });
  const nextSweep = new Date(+forming.at(-1).createdAt + 30000);
  const sweep = await runPoolLockSweep({ now: nextSweep, dispatch: true });
  assert.equal(sweep.lockedCount, 0);

  for (const [members, technician] of [[[1,2,3], 1], [[4,5], 4], [[6], 2], [[7], 1], [[8], 3], [[9], 2], [[10], 5]]) {
    const group = members.map(n => visits[n - 1]);
    const tech = techs[technician - 1];
    const id = group[0].pool;
    const pool = await ServicePool.findById(id);
    assert.equal(pool.status, 'assigned');
    assert.equal(String(pool.assignedTechnicianId), tech.user._id);
    assert.deepEqual(pool.members.map(m => String(m.bookingId)).sort(), group.map(v => v.id).sort());
    const path = '/technicians/me/jobs/' + id;
    const route = await api(path + '/route', 'GET', tech.token);
    assert.equal(route.provider, 'mock');
    assert.equal(route.schedulingConflicts.length, 0);
    const order = route.stops.map(stop => group.find(v => v.id === stop.bookingId));
    assert.equal(new Set(order).size, group.length);
    for (const [i, stop] of route.stops.entries()) {
      assert.ok(Date.parse(stop.estimatedServiceStart) >= Date.parse(order[i].window.start));
      assert.ok(Date.parse(stop.estimatedServiceEnd) <= Date.parse(order[i].window.end));
    }
    // Independently compare travel for feasible permutations, including every service duration.
    const matrix = await new MockRoadRoutingProvider().getDistanceMatrix([tech.base, ...group.map(v => v.location)]);
    const times = permutations(group.map((_, i) => i + 1)).flatMap(path => {
      let cursor = +at(9);
      let travel = 0;
      for (const [i, stop] of path.entries()) {
        const leg = matrix.durations[i ? path[i - 1] : 0][stop];
        const window = group[stop - 1].window;
        travel += leg;
        cursor = Math.max(cursor + leg * 1000, Date.parse(window.start)) + 30 * 60000;
        if (cursor > Date.parse(window.end)) return [];
      }
      return [travel];
    });
    // Later jobs can depart from the preceding appointment.
    if (group.length > 1) assert.equal(route.totalTravelTime.seconds, Math.min(...times));
    await api(path + '/accept', 'POST', tech.token, {});
    const accepted = await ServicePool.findById(id);
    assert.deepEqual(accepted.routeOrder.map(stop => String(stop.bookingId)), order.map(v => v.id));
    const fares = [];
    for (const v of group) {
      const receipt = await api('/bookings/' + v.id, 'GET', v.account.token);
      assert.equal(receipt.technicianId, tech.user._id);
      fares.push(receipt.estimatedPrice);
    }
    t.diagnostic([group.map(v => v.name).join('/'), tech.user.name, order.map(v => v.name).join(' → '),
      route.totalTravelDistance.meters + ' m', Math.min(...times) + ' s', fares.join('/'), route.stops.map(s => clock(s.estimatedServiceStart)).join('/')].join(' | '));
  }
  assert.equal(await Booking.countDocuments({ status: 'accepted' }), 10);
});
