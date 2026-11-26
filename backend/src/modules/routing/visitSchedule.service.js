// Automatic visits reserve a contiguous run between the technician's other appointments.
// All routing decisions use the same road matrix and require a complete, finite leg.
import { Booking, ServicePool, TechnicianProfile, Notification } from '../../models/index.js';
import { allocateSavings } from '../pools/pricing.service.js';
import { env } from '../../config/env.js';
import { planSharedGeometry } from './customerRoute.service.js';
import { getDefaultRoutingProvider } from './routingProvider.factory.js';
import { haversineDistanceKm } from '../../utils/geo.js';
import { STALE_LOCATION_THRESHOLD_SECONDS } from '../technicians/technicianLocation.service.js';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const IST_OFFSET = 330 * MINUTE;
export const SHIFT_LIMIT_MS = 2 * 60 * MINUTE;
const dayStart = ms => Math.floor((ms + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
const minutes = clock => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const id = value => String(value?._id || value);
const active = ['assigned', 'accepted', 'arrived', 'in_progress'];

async function commitments(profile, pool, session, now) {
  const technician = profile.userId._id;
  const pools = await ServicePool.find({ _id: { $ne: pool._id }, $or: [
    { assignedTechnicianId: technician, status: { $in: active } },
    { reservedTechnicianId: technician, status: 'forming' },
  ] }).populate('members.bookingId', 'status departedAt arrivedAt startedAt').session(session).lean();
  const bookings = await Booking.find({ technicianId: technician, poolId: null, status: { $in: active } })
    .session(session).lean();
  const intervals = bookings.map(b => ({ ...b.timeWindow, from: b.location, to: b.location }));
  for (const p of pools) {
    const members = p.members.filter(m => m.status === 'active');
    const order = p.routeOrder.filter(s => members.some(m => id(m.bookingId) === id(s.bookingId)))
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    const timed = members.length && order.length === members.length &&
      order.every(s => s.estimatedServiceStart && s.estimatedServiceEnd);
    const point = stop => members.find(m => id(m.bookingId) === id(stop?.bookingId))?.location;
    const sole = members.length === 1 ? members[0].location : null;
    const interval = timed ? { start: order[0].estimatedServiceStart, end: order.at(-1).estimatedServiceEnd,
      from: point(order[0]), to: point(order.at(-1)) } : { ...p.aggregateTimeWindow, from: sole, to: sole };
    const underway = members.map(m => m.bookingId).filter(b => b && b.status !== 'completed' && (b.departedAt || b.arrivedAt || b.startedAt));
    if (underway.length) {
      interval.start = new Date(Math.min(+interval.start, ...underway.map(b => +(b.departedAt || b.arrivedAt || b.startedAt))));
      // An overdue job without a recorded finish has no reliable exit time.
      interval.end = new Date(Math.max(+interval.end, +p.aggregateTimeWindow.end,
        +interval.end <= +now ? dayStart(+now) + DAY : 0));
    }
    intervals.push(interval);
  }
  return intervals.sort((a, b) => +a.start - +b.start);
}

async function roadMatrix(points) {
  if (points.length < 2) return { durations: [[0]], distances: [[0]] };
  try {
    const matrix = await getDefaultRoutingProvider().getDistanceMatrix(points.map(p =>
      ({ lng: p.coordinates[0], lat: p.coordinates[1] })));
    const { durations } = matrix;
    if (durations.length === points.length && durations.every(row => row.length === points.length &&
        row.every(s => Number.isFinite(s) && s >= 0))) return matrix;
  } catch { /* An unverifiable route is ineligible for confirmation. */ }
  return null;
}

// Backward latest-start bounds include travel to the following appointment. The
// forward pass then picks the smallest consented shift for this insertion.
function schedule(order, { matrix, origin, destination, open, close, duration, allowShift, extra, now }) {
  const leg = (a, b) => a == null || b == null ? 0 : matrix[a][b] * 1000;
  let next = destination;
  let latest = close;
  const bounds = new Map();
  for (const stop of [...order].reverse()) {
    const end = +stop.timeWindow.end + (stop === extra && allowShift ? SHIFT_LIMIT_MS : 0);
    latest = Math.min(end, latest - leg(stop.node, next)) - duration;
    bounds.set(stop, latest);
    next = stop.node;
  }
  let cursor = open;
  let last = origin;
  let travel = 0;
  let shift = 0;
  const routeOrder = [];
  for (const stop of order) {
    const distanceTime = leg(last, stop.node);
    travel += distanceTime;
    const earliest = cursor + distanceTime;
    const window = stop.timeWindow;
    if (allowShift && stop === extra) {
      shift = Math.max(earliest + duration - +window.end, Math.min(0, bounds.get(stop) - +window.start));
      if (Math.abs(shift) > SHIFT_LIMIT_MS || +window.start + shift <= +now) return null;
    }
    const offset = stop === extra ? shift : 0;
    const start = Math.max(earliest, +window.start + offset);
    cursor = start + duration;
    if (start > bounds.get(stop) || cursor > +window.end + offset) return null;
    // Depart just in time for the first scheduled visit when the technician can wait at origin.
    routeOrder.push({ bookingId: stop._id, sequenceIndex: routeOrder.length + 1,
      estimatedArrival: new Date(start), estimatedServiceStart: new Date(start),
      estimatedServiceEnd: new Date(cursor) });
    last = stop.node;
  }
  travel += leg(last, destination);
  return { routeOrder, travel, shift, extraTravel: travel - leg(origin, destination) };
}

// Before a technician is assigned there is no fixed stop order. Prune partial
// tours as soon as a window cannot be met or the best travel cost is exceeded.
function initialTour(stops, context) {
  const { matrix, origin, open, close, duration } = context;
  let best = schedule(stops, context);
  const seen = new Map();
  function visit(path, remaining, last, cursor, travel) {
    const key = last + '/' + remaining.map(stop => stop.node).join(',');
    const previous = seen.get(key) || [];
    if (previous.some(entry => entry.cursor <= cursor && entry.travel <= travel)) return;
    seen.set(key, [...previous.filter(entry => entry.cursor < cursor || entry.travel < travel), { cursor, travel }]);
    if (!remaining.length) {
      const candidate = schedule(path, context);
      if (candidate && (!best || candidate.travel < best.travel)) best = candidate;
      return;
    }
    for (const stop of remaining) {
      const leg = matrix[last][stop.node] * 1000;
      const end = Math.max(cursor + leg, +stop.timeWindow.start) + duration;
      if (end > Math.min(close, +stop.timeWindow.end) || (best && travel + leg >= best.travel)) continue;
      visit([...path, stop], remaining.filter(b => b !== stop), stop.node, end, travel + leg);
    }
  }
  visit([], stops, origin, open, 0);
  return best;
}

function betterPlan(plan, current) {
  return plan && (!current || Math.abs(plan.shift) < Math.abs(current.shift) ||
    (Math.abs(plan.shift) === Math.abs(current.shift) && plan.extraTravel < current.extraTravel));
}

function addRoadMetrics(plan, roads, origin, stops) {
  if (origin == null) return;
  const nodes = new Map(stops.map((b, i) => [id(b), i]));
  let last = origin;
  let savedMeters = 0;
  for (const stop of plan.routeOrder) {
    const node = nodes.get(id(stop.bookingId));
    savedMeters += roads.distances?.[origin]?.[node] - roads.distances?.[last]?.[node];
    last = node;
  }
  if (Number.isFinite(savedMeters)) plan.savings = allocateSavings(savedMeters, env.travelCostPerKm, plan.routeOrder);
  const first = plan.routeOrder[0];
  const firstNode = nodes.get(id(first.bookingId));
  plan.departure = new Date(+first.estimatedServiceStart - roads.durations[origin][firstNode] * 1000);
}

async function planGap(stops, { from, to, open, close, duration, extra, allowShift, now, initialAssignment }) {
  const points = stops.map(b => b.location);
  const origin = from ? points.push(from) - 1 : null;
  const destination = to ? points.push(to) - 1 : null;
  const roads = await roadMatrix(points);
  if (!roads) return null;
  const indexed = stops.map((b, node) => ({ _id: b._id, timeWindow: b.timeWindow, node }));
  const inserted = extra && indexed.pop();
  const orders = inserted ? Array.from({ length: indexed.length + 1 }, (_, i) =>
    [...indexed.slice(0, i), inserted, ...indexed.slice(i)]) : [indexed];
  const context = { matrix: roads.durations, origin, destination, open, close, duration, allowShift, extra: inserted, now };
  const baseline = inserted && schedule(indexed, context);
  let best;
  for (const order of orders) {
    const plan = initialAssignment ? initialTour(order, context) : schedule(order, context);
    if (!plan || (allowShift && !plan.shift)) continue;
    if (baseline) plan.extraTravel = plan.travel - baseline.travel;
    if (betterPlan(plan, best)) best = plan;
  }
  if (!best) return null;
  addRoadMetrics(best, roads, origin, stops);
  return { ...best, origin: from, provider: roads.provider };
}

export async function planVisitSchedule(pool, { category, extra, allowShift = false, profile, session = null, now = new Date() }) {
  if (extra && !extra._id) extra = { ...extra, _id: 'proposed' };
  if (!profile && pool.assignedTechnicianId) {
    profile = await TechnicianProfile.findOne({ userId: pool.assignedTechnicianId }).populate('userId', 'isActive').session(session);
    if (!profile) return null;
  }
  const members = pool.members.filter(m => m.status === 'active');
  const records = await Booking.find({ _id: { $in: members.map(m => m.bookingId) } }).session(session).lean();
  if (!records.length || records.length !== members.length) return null;
  const saved = new Map(pool.routeOrder.map(s => [id(s.bookingId), s]));
  if (pool.assignedTechnicianId && extra && records.some(b => {
    const stop = saved.get(id(b));
    return !stop?.estimatedServiceStart || !stop.estimatedServiceEnd || id(b.technicianId) !== id(pool.assignedTechnicianId);
  })) return null;
  records.sort((a, b) => (saved.get(id(a))?.sequenceIndex ?? a.stopSequence) - (saved.get(id(b))?.sequenceIndex ?? b.stopSequence));
  const duration = category.estimatedDurationMins * MINUTE;
  if (!duration) return null;
  const history = [];
  // Keep the executed/en-route prefix intact. Resume at its last known location.
  let anchor = null;
  while (records.length && (['arrived', 'completed', 'in_progress'].includes(records[0].status) || records[0].departedAt)) {
    const b = records.shift();
    const s = saved.get(id(b));
    if (!s?.estimatedServiceEnd) return null;
    history.push(s.toObject?.() || s);
    if (b.departedAt && !b.arrivedAt && +now > +s.estimatedServiceStart) return null;
    const end = b.completedAt || new Date(Math.max(+s.estimatedServiceEnd, +(b.startedAt || (b.arrivedAt && now) || s.estimatedServiceStart) + duration));
    if (b.status !== 'completed' && (+end < +now || +end > +b.timeWindow.end)) return null;
    anchor = { location: b.location, end };
  }
  if (records.some(b => b.departedAt || ['completed', 'arrived', 'in_progress'].includes(b.status))) return null;
  const stops = extra ? [...records, extra] : records;
  if (!stops.length) return null;
  if (profile && (!profile.userId?.isActive || profile.approvalStatus !== 'approved' ||
      !(profile.availabilityStatus === 'available' || (pool.assignedTechnicianId && profile.availabilityStatus === 'busy')) ||
      !profile.serviceCategories.some(c => id(c) === id(pool.serviceCategoryId)) ||
      !profile.baseLocation || stops.some(b => haversineDistanceKm(profile.baseLocation, b.location) > profile.serviceRadiusKm))) return null;
  const appointments = profile ? await commitments(profile, pool, session, now) : [];
  if (profile && appointments.length >= profile.maxPoolCapacity && !pool.assignedTechnicianId) return null;
  const hours = profile?.workingHours;
  if (profile && !hours?.daysOfWeek?.length) return null;
  const firstDay = dayStart(Math.max(+now, ...stops.map(b => +b.timeWindow.start - (b === extra && allowShift ? SHIFT_LIMIT_MS : 0))));
  const lastDay = dayStart(Math.min(...stops.map(b => +b.timeWindow.end + (b === extra && allowShift ? SHIFT_LIMIT_MS : 0))));
  const lastWorkWeek = Math.max(firstDay, ...appointments.map(job => +job.end)) + 8 * DAY;
  let best = null;
  for (let day = firstDay; day <= Math.min(lastDay, lastWorkWeek); day += DAY) {
    if (hours && !hours.daysOfWeek.includes(new Date(day + IST_OFFSET).getUTCDay())) continue;
    const start = Math.max(day + (hours ? minutes(hours.start) * MINUTE : 0), +now, anchor ? +anchor.end : 0);
    const end = day + (hours ? minutes(hours.end) * MINUTE : DAY);
    if (end - start < stops.length * duration) continue;
    const jobs = appointments.filter(job => +job.end >= day && +job.start < day + DAY);
    const imminent = Math.max(start, Math.min(...stops.map(b => +b.timeWindow.start))) - +now <= 60 * MINUTE;
    const live = imminent && profile?.currentLocation && profile.lastLocationUpdate && now - profile.lastLocationUpdate <= STALE_LOCATION_THRESHOLD_SECONDS * 1000;
    let from = anchor?.location || (live ? profile.currentLocation : profile?.baseLocation);
    let open = start;
    for (const job of [...jobs, null]) {
      const close = Math.min(end, job ? +job.start : Infinity);
      if (close - open >= stops.length * duration && (!profile || from) && (!job || job.from)) {
        const plan = await planGap(stops, { from, to: job?.from, open, close, duration, extra, allowShift, now,
          initialAssignment: profile && !pool.assignedTechnicianId && !extra });
        if (betterPlan(plan, best)) best = plan;
      }
      if (job && +job.end >= open) { open = +job.end; from = job.to; }
      else if (job && +job.end <= start && !anchor && !live) from = job.to;
    }
    if (best) break;
  }
  if (!best) return null;
  best.routeOrder = [...history, ...best.routeOrder.map(stop => ({
    ...stop, sequenceIndex: stop.sequenceIndex + (history.at(-1)?.sequenceIndex || 0),
  }))];
  if (extra) best.offeredWindow = { start: new Date(+extra.timeWindow.start + best.shift), end: new Date(+extra.timeWindow.end + best.shift) };
  return best;
}

export async function planVisitInsertion(pool, options) {
  if (pool.assignedTechnicianId) return planVisitSchedule(pool, options);
  const profiles = await TechnicianProfile.find({ approvalStatus: 'approved', availabilityStatus: 'available',
    serviceCategories: pool.serviceCategoryId, userId: { $nin: pool.rejectedTechnicians || [] } })
    .populate('userId', 'isActive').session(options.session);
  // A forming group can wait for dispatch. Once a technician is available, check
  // the whole itinerary, including the approach and adjacent appointments.
  if (!profiles.length) return planVisitSchedule(pool, options);
  let best = null;
  for (const profile of profiles) {
    const plan = await planVisitSchedule(pool, { ...options, profile });
    if (betterPlan(plan, best)) best = plan;
  }
  return best;
}

export async function applyVisitSchedule(pool, plan, session) {
  for (const stop of plan.routeOrder) {
    const old = pool.routeOrder.find(s => id(s.bookingId) === id(stop.bookingId));
    const member = pool.members.find(m => id(m.bookingId) === id(stop.bookingId));
    if (pool.assignedTechnicianId && old?.estimatedServiceStart &&
        Math.abs(old.estimatedServiceStart - stop.estimatedServiceStart) >= 5 * MINUTE) {
      await Notification.create([{ userId: member.customerId, role: 'customer', type: 'booking', relatedEntityId: stop.bookingId,
        title: 'Visit ETA updated', message: 'Your updated ETA is ' + stop.estimatedServiceStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST.' }], { session });
    }
    const saving = pool.assignedTechnicianId && plan.savings?.find(s => id(s.bookingId) === id(stop.bookingId));
    const routeSavings = saving && { provider: plan.provider, costPerKm: env.travelCostPerKm,
      customerPaise: saving.customerPaise, technicianPaise: saving.technicianPaise, platformPaise: saving.platformPaise };
    await Booking.updateOne({ _id: stop.bookingId }, { $set: { stopSequence: stop.sequenceIndex,
      ...(routeSavings && { routeSavings }) } }, { session });
  }
  pool.routeOrder = plan.routeOrder;
  pool.routeOrigin = plan.origin;
  pool.routeDeparture = plan.departure;
  if (pool.assignedTechnicianId && plan.provider) {
    const points = pool.routeOrder.map(stop => pool.members.find(m => id(m.bookingId) === id(stop.bookingId)).location.coordinates);
    pool.sharedGeometry = await planSharedGeometry(points, plan.provider, pool.sharedGeometry);
  } else pool.sharedGeometry = undefined;
}
