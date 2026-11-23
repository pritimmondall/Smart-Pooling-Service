import { buildingKey, getScope, scheduledWindow, serviceOptions } from '../pools/poolOptions.js';
import mongoose from 'mongoose';
import {
  Booking,
  User,
  ServiceCategory,
  ServiceZone,
  ServicePool,
  Notification,
  BOOKING_MODES,
  BOOKING_STATUSES,
} from '../../models/index.js';
import { calculatePoolPricing } from '../pools/pricing.service.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parseGeoInput } from '../../utils/geo.js';
import { parsePagination } from '../../utils/pagination.js';
import { sendSuccess } from '../../utils/response.js';
import {
  matchAndAssignBooking,
  findCompatiblePools,
  runBookingTransaction,
  removeBookingFromPool,
} from '../pools/matching.service.js';
import {
  assignBookingToTechnician,
  findEligibleTechniciansForBooking,
} from '../pools/poolAssignment.service.js';

/**
 * Parses and validates booking preferred time window boundaries.
 */
function parseTimeWindow(timeWindow) {
  if (!timeWindow || !timeWindow.start || !timeWindow.end) {
    throw new AppError(400, 'timeWindow.start and timeWindow.end are required.', 'VALIDATION_ERROR');
  }

  const start = new Date(timeWindow.start);
  const end = new Date(timeWindow.end);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError(400, 'timeWindow start and end must be valid ISO dates.', 'VALIDATION_ERROR');
  }
  if (end <= start) {
    throw new AppError(400, 'timeWindow.end must be strictly after timeWindow.start.', 'VALIDATION_ERROR');
  }
  if (start <= new Date()) {
    throw new AppError(400, 'Booking time window start must be in the future.', 'VALIDATION_ERROR');
  }

  return { start, end };
}

/**
 * Estimates the price using the same ranked candidates used at booking time.
 */
export const quoteBooking = asyncHandler(async (req, res) => {
  const { serviceCategoryId, location, timeWindow } = req.body;
  if (!mongoose.isValidObjectId(serviceCategoryId)) throw new AppError(400, 'Invalid service category.', 'INVALID_ID');
  const category = await ServiceCategory.findOne({ _id: serviceCategoryId, isActive: true });
  if (!category) throw new AppError(404, 'Service unavailable.', 'SERVICE_NOT_FOUND');
  const candidates = await findCompatiblePools({
    customerId: req.user._id, serviceCategoryId, specificService: req.body.specificService, location: parseGeoInput(location), timeWindow: parseTimeWindow(timeWindow),
  });
  const [candidate] = candidates;
  const pricing = calculatePoolPricing({
    basePrice: category.baseIndividualPrice, memberCount: (candidate?.activeMembersCount || 0) + 1,
  });
  const nearbyPools = candidates.sort((a, b) => a.distanceKm - b.distanceKm).map(candidate => ({
    id: candidate.pool._id,
    distanceMeters: Math.round(candidate.distanceKm * 1000),
    memberCount: candidate.activeMembersCount,
    pricing: calculatePoolPricing({ basePrice: category.baseIndividualPrice, memberCount: candidate.activeMembersCount + 1 }),
  }));
  const recommendedMatch = candidate ? {
    distanceMeters: Math.round(candidate.distanceKm * 1000),
    overlapMinutes: Math.floor((candidate.newIntersection.end - candidate.newIntersection.start) / 60000),
  } : null;
  return sendSuccess(res, { data: { ...pricing, nearbyPools, recommendedMatch } });
});

export const createBooking = asyncHandler(async (req, res) => {
  const {
    serviceCategoryId,
    zoneId,
    location,
    addressText,
    timeWindow,
    bookingMode = 'pool',
    notes,
  } = req.body || {};

  if (!BOOKING_MODES.includes(bookingMode)) {
    throw new AppError(400, `bookingMode must be one of: ${BOOKING_MODES.join(', ')}.`, 'VALIDATION_ERROR');
  }

  if (!mongoose.isValidObjectId(serviceCategoryId)) {
    throw new AppError(400, 'Valid serviceCategoryId is required.', 'INVALID_ID');
  }

  const category = await ServiceCategory.findOne({ _id: serviceCategoryId, isActive: true });
  if (!category) {
    throw new AppError(404, 'Active service category not found.', 'SERVICE_NOT_FOUND');
  }

  if (req.body.quotedPrice !== undefined && (!Number.isFinite(req.body.quotedPrice) || req.body.quotedPrice < 0)) {
    throw new AppError(400, 'Invalid quoted price.', 'VALIDATION_ERROR');
  }

  const { targetPoolId } = req.body;
  if (targetPoolId !== undefined && (bookingMode !== 'pool' || !mongoose.isObjectIdOrHexString(targetPoolId))) {
    throw new AppError(400, 'Invalid selected pool.', 'INVALID_ID');
  }

  let validatedZoneId = null;
  if (zoneId !== undefined && zoneId !== null) {
    if (!mongoose.isValidObjectId(zoneId)) {
      throw new AppError(400, 'Invalid zoneId format.', 'INVALID_ID');
    }
    const zone = await ServiceZone.findOne({ _id: zoneId, isActive: true });
    if (!zone) {
      throw new AppError(404, 'Active service zone not found.', 'ZONE_NOT_FOUND');
    }
    validatedZoneId = zone._id;
  }

  const geoLocation = parseGeoInput(location);
  const target = targetPoolId ? await ServicePool.findById(targetPoolId) : null;
  if (targetPoolId && (!target || String(target.serviceCategoryId) !== String(category._id))) {
    throw new AppError(409, 'This pool is unavailable.', 'POOL_UNAVAILABLE');
  }
  const specificService = target ? target.specificService : req.body.specificService;
  if (specificService && !serviceOptions(category).services.includes(specificService)) {
    throw new AppError(400, 'Choose a service in this domain.', 'INVALID_SERVICE');
  }
  const scopeKey = bookingMode === 'pool' ? (target ? target.poolScope : req.body.poolScope) : undefined;
  const scope = scopeKey === undefined ? null : getScope(scopeKey);
  const building = scopeKey === 'building' ? buildingKey(req.body.building) : undefined;
  if (scope && (!specificService || (scopeKey === 'building' && !building))) {
    throw new AppError(400, 'Select a service and enter the building name for an apartment-area pool.', 'VALIDATION_ERROR');
  }
  const parsedWindow = target ? target.aggregateTimeWindow : scope
    ? scheduledWindow(category, scope.capacity) : parseTimeWindow(timeWindow);

  const { booking, pool: assignedPool } = await runBookingTransaction(async session => {
    await User.updateOne({ _id: req.user._id, poolAlertLocation: null }, { poolAlertLocation: geoLocation }, { session });
    const [booking] = await Booking.create([{
      customerId: req.user._id,
      specificService, poolScope: scopeKey, buildingKey: building,
      serviceCategoryId: category._id,
      zoneId: validatedZoneId,
      location: geoLocation,
      addressText,
      timeWindow: parsedWindow,
      bookingMode,
      status: 'pending',
      estimatedPrice: category.baseIndividualPrice,
      notes,
    }], { session });
    if (bookingMode === 'pool') {
      const matched = await matchAndAssignBooking(booking._id, { session, targetPoolId });
      if (req.body.quotedPrice !== undefined && matched.booking.estimatedPrice > req.body.quotedPrice) {
        throw new AppError(409, 'The pool price changed. Review the updated quote.', 'QUOTE_CHANGED');
      }
      return matched;
    }
    await Notification.create([{
      userId: req.user._id, role: 'customer', title: 'Booking Request Created',
      message: `Your ${category.name} individual booking request has been created.`,
      type: 'booking', relatedEntityId: booking._id,
    }], { session });
    return { booking, pool: null };
  });

  const freshBooking = await Booking.findById(booking._id)
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins defaultPoolRadiusKm maxPoolSize poolLockCutoffMins')
    .populate('zoneId', 'name code city')
    .populate('poolId', 'status maxCapacity poolRadiusKm aggregateTimeWindow lockCutoffTime pricing');

  return sendSuccess(res, {
    statusCode: 201,
    message: assignedPool
      ? `Booking created and matched to service pool (${assignedPool.status}).`
      : 'Individual booking created.',
    data: freshBooking,
  });
});

export const getDashboardBooking = asyncHandler(async (req, res) => {
  const customerId = req.user._id;
  const select = 'specificService serviceCategoryId poolId technicianId status estimatedPrice timeWindow';
  const next = await Booking.findOne({ customerId, status: { $nin: ['completed', 'cancelled'] } })
    .sort({ 'timeWindow.start': 1, _id: 1 }).select(select).lean()
    || await Booking.findOne({ customerId, status: 'completed', customerConfirmedAt: null })
      .sort({ updatedAt: -1 }).select(select).lean();
  if (!next) return sendSuccess(res, { data: null });

  const [service, technician, pool] = await Promise.all([
    ServiceCategory.findById(next.serviceCategoryId, 'name').lean(),
    next.technicianId && User.findById(next.technicianId, 'name').lean(),
    next.poolId && ServicePool.findById(next.poolId, 'status pricing.memberCount lockCutoffTime aggregateTimeWindow routeOrder.bookingId routeOrder.estimatedServiceStart').lean(),
  ]);
  const stop = pool?.routeOrder?.find(item => String(item.bookingId) === String(next._id));
  return sendSuccess(res, { data: {
    id: next._id, service: next.specificService || service?.name, status: next.status,
    price: next.estimatedPrice, technician: technician?.name, estimatedStart: stop?.estimatedServiceStart,
    window: pool?.aggregateTimeWindow || next.timeWindow,
    pool: pool && { status: pool.status, members: pool.pricing?.memberCount, deadline: pool.lockCutoffTime },
  } });
});

/**
 * Lists bookings belonging to the authenticated customer.
 */
export const getMyBookings = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { customerId: req.user._id };

  if (req.query.status !== undefined) {
    if (!BOOKING_STATUSES.includes(req.query.status)) {
      throw new AppError(400, `status filter must be one of: ${BOOKING_STATUSES.join(', ')}.`, 'VALIDATION_ERROR');
    }
    filter.status = req.query.status;
  }

  const [items, total] = await Promise.all([
    Booking.find(filter)
      .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins defaultPoolRadiusKm maxPoolSize poolLockCutoffMins')
      .populate('zoneId', 'name code city')
      .populate('poolId', 'status maxCapacity poolRadiusKm aggregateTimeWindow lockCutoffTime pricing')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(filter),
  ]);

  const summary = {};
  if (req.query.summary === 'true') {
    const groups = await Booking.aggregate([
      { $match: { customerId: req.user._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    summary.byStatus = Object.fromEntries(groups.map(row => [row._id, row.count]));
  }
  return sendSuccess(res, {
    data: items,
    meta: { ...summary, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
  });
});

/**
 * Fetches a single booking. Customers may only view their own bookings; Admins may view any.
 */
export const confirmCompletion = asyncHandler(async (req, res) => {
  const filter = { _id: req.params.id, customerId: req.user._id, status: 'completed' };
  const booking = await Booking.findOneAndUpdate(
    { ...filter, customerConfirmedAt: null }, { $set: { customerConfirmedAt: new Date() } }, { new: true }
  ) || await Booking.findOne(filter);
  if (!booking) throw new AppError(409, 'Only your completed bookings can be confirmed.', 'INVALID_STATUS');
  return sendSuccess(res, { data: { customerConfirmedAt: booking.customerConfirmedAt } });
});

export const getBookingById = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins defaultPoolRadiusKm maxPoolSize poolLockCutoffMins')
    .populate('zoneId', 'name code city')
    .populate('poolId', 'status maxCapacity poolRadiusKm aggregateTimeWindow lockCutoffTime pricing');

  if (!booking) {
    throw new AppError(404, 'Booking not found.', 'BOOKING_NOT_FOUND');
  }

  const isOwner = String(booking.customerId) === String(req.user._id);
  if (req.user.role !== 'admin' && !isOwner) {
    throw new AppError(403, 'You do not have permission to view this booking.', 'FORBIDDEN_BOOKING_ACCESS');
  }

  if (booking.poolScope && booking.poolId) {
    const pool = await ServicePool.findById(booking.poolId._id, 'members.bookingId members.status aggregateTimeWindow').lean();
    const position = pool?.members.filter(m => m.status === 'active').findIndex(m => String(m.bookingId) === String(booking._id));
    if (position >= 0) {
      const estimatedStart = new Date(+pool.aggregateTimeWindow.start + position * (booking.serviceCategoryId.estimatedDurationMins + 15) * 60000);
      return sendSuccess(res, { data: { ...booking.toObject(), visitPosition: position + 1, estimatedStart } });
    }
  }
  return sendSuccess(res, { data: booking });
});

/**
 * Updates editable details of a pending customer booking.
 */
export const updateMyBooking = asyncHandler(async (req, res) => {
  const booking = await runBookingTransaction(async session => {
    const booking = await Booking.findById(req.params.id).session(session);
    if (!booking) {
      throw new AppError(404, 'Booking not found.', 'BOOKING_NOT_FOUND');
    }

    if (String(booking.customerId) !== String(req.user._id)) {
      throw new AppError(403, 'You can only update your own bookings.', 'FORBIDDEN_BOOKING_ACCESS');
    }

    if (booking.status !== 'pending') {
      throw new AppError(409, `Only pending bookings can be edited (current status: "${booking.status}").`, 'INVALID_STATUS');
    }

    const { location, addressText, timeWindow, bookingMode, notes } = req.body || {};
    if (booking.specificService && bookingMode === 'pool' && booking.bookingMode === 'individual') {
      throw new AppError(409, 'Use manual booking to choose a pool area or join a nearby pool.', 'POOL_AREA_REQUIRED');
    }
    if (booking.poolScope && [timeWindow, location, bookingMode, addressText].some(value => value !== undefined)) {
      throw new AppError(409, 'Cancel and rebook to change a scheduled pool.', 'SCHEDULED_POOL');
    }
    let rematchedNeeded = false;

    if (location !== undefined) {
      const point = parseGeoInput(location);
      rematchedNeeded = point.coordinates.some((v, i) => v !== booking.location.coordinates[i]);
      booking.location = point;
    }
    if (addressText !== undefined && addressText !== booking.addressText) {
      booking.addressText = addressText;
      rematchedNeeded = true;
    }
    if (timeWindow !== undefined) {
      const next = parseTimeWindow(timeWindow);
      rematchedNeeded ||= +next.start !== +booking.timeWindow.start || +next.end !== +booking.timeWindow.end;
      booking.timeWindow = next;
    }
    if (bookingMode !== undefined) {
      if (!BOOKING_MODES.includes(bookingMode)) {
        throw new AppError(400, `bookingMode must be one of: ${BOOKING_MODES.join(', ')}.`, 'VALIDATION_ERROR');
      }
      if (booking.bookingMode !== bookingMode) {
        booking.bookingMode = bookingMode;
        if (bookingMode === 'individual') {
          const category = await ServiceCategory.findById(booking.serviceCategoryId).session(session);
          if (!category) throw new AppError(404, 'Service unavailable.', 'SERVICE_NOT_FOUND');
          booking.estimatedPrice = category.baseIndividualPrice;
        }
        rematchedNeeded = true;
      }
    }
    if (notes !== undefined) booking.notes = notes;

    await booking.save({ session });

    if (rematchedNeeded) {
      if (booking.poolId) {
        await removeBookingFromPool(booking._id, session);
      }
      if (booking.bookingMode === 'pool') {
        await matchAndAssignBooking(booking._id, { session });
      }
    }
    return booking;
  });

  const freshBooking = await Booking.findById(booking._id)
    .populate('serviceCategoryId', 'name slug baseIndividualPrice estimatedDurationMins defaultPoolRadiusKm maxPoolSize poolLockCutoffMins')
    .populate('zoneId', 'name code city')
    .populate('poolId', 'status maxCapacity poolRadiusKm aggregateTimeWindow lockCutoffTime pricing');

  return sendSuccess(res, {
    message: 'Booking updated.',
    data: freshBooking,
  });
});

/**
 * Cancels a pending customer booking.
 */
export const cancelMyBooking = asyncHandler(async (req, res) => {
  const booking = await runBookingTransaction(async session => {
    const booking = await Booking.findById(req.params.id).session(session);
    if (!booking) {
      throw new AppError(404, 'Booking not found.', 'BOOKING_NOT_FOUND');
    }

    if (String(booking.customerId) !== String(req.user._id)) {
      throw new AppError(403, 'You can only cancel your own bookings.', 'FORBIDDEN_BOOKING_ACCESS');
    }

    if (booking.status !== 'pending') {
      throw new AppError(
        409,
        `Booking in status "${booking.status}" cannot be cancelled.`,
        'BOOKING_CANNOT_CANCEL'
      );
    }

    if (booking.poolId) {
      await removeBookingFromPool(booking._id, session);
    }

    booking.status = 'cancelled';
    booking.poolId = null;
    await booking.save({ session });
    return booking;
  });

  return sendSuccess(res, {
    message: 'Booking cancelled.',
    data: booking,
  });
});

/**
 * Lists all platform bookings with optional validated filters (Admin only).
 */
export const listAllBookingsAdmin = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  if (req.query.status !== undefined) {
    if (!BOOKING_STATUSES.includes(req.query.status)) {
      throw new AppError(400, `status filter must be one of: ${BOOKING_STATUSES.join(', ')}.`, 'VALIDATION_ERROR');
    }
    filter.status = req.query.status;
  }

  if (req.query.serviceCategoryId !== undefined) {
    if (!mongoose.isValidObjectId(req.query.serviceCategoryId)) {
      throw new AppError(400, 'Invalid serviceCategoryId filter.', 'INVALID_ID');
    }
    filter.serviceCategoryId = req.query.serviceCategoryId;
  }

  const [items, total] = await Promise.all([
    Booking.find(filter)
      .populate('customerId', 'name email phone')
      .populate('serviceCategoryId', 'name slug baseIndividualPrice')
      .populate('zoneId', 'name code city')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    data: items,
    meta: { pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
  });
});

/**
 * Lists eligible technicians for an individual booking (Admin only).
 */
export const getEligibleTechniciansForBookingHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await findEligibleTechniciansForBooking(id);
  return sendSuccess(res, { data: result });
});

/**
 * Assigns an individual booking to an eligible technician (Admin only).
 */
export const assignBookingHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { technicianId } = req.body || {};
  if (!technicianId) {
    throw new AppError(400, 'technicianId is required in request body.', 'VALIDATION_ERROR');
  }

  const assignedBooking = await assignBookingToTechnician(id, technicianId);
  return sendSuccess(res, {
    message: 'Booking assigned to technician.',
    data: assignedBooking,
  });
});
