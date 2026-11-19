import mongoose from 'mongoose';
import {
  TechnicianProfile,
  ServiceCategory,
  ServiceZone,
  ServicePool,
  Booking,
  Notification,
  AVAILABILITY_STATUSES,
  APPROVAL_STATUSES,
} from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parseGeoInput } from '../../utils/geo.js';
import { parsePagination } from '../../utils/pagination.js';
import { sendSuccess } from '../../utils/response.js';
import { getTechnicianDashboardMetrics } from './technicianMetrics.service.js';

/**
 * Fetches the authenticated technician's dashboard metrics.
 * Derived strictly from authenticated request user context (req.user._id).
 */
export const getMyEarnings = asyncHandler(async (req, res) => {
  const [totals] = await Booking.aggregate([
    { $match: { technicianId: req.user._id, status: 'completed' } },
    { $project: {
      fare: { $round: [{ $multiply: ['$estimatedPrice', 100] }, 0] },
    } },
    { $group: {
      _id: null, completedServices: { $sum: 1 },
      servicePaise: { $sum: '$fare' },
    } },
  ]);
  const { completedServices = 0, servicePaise = 0, incentivePaise = 0 } = totals || {};
  return sendSuccess(res, { data: { completedServices, servicePaise, incentivePaise,
    totalPaise: servicePaise + incentivePaise } });
});

export const getMyTechnicianMetrics = asyncHandler(async (req, res) => {
  const { timezone } = req.query;
  const metrics = await getTechnicianDashboardMetrics(req.user._id, { timeZone: timezone });
  return sendSuccess(res, { data: metrics });
});

/**
 * Fetches the authenticated technician's extended profile.
 */
export const getMyTechnicianProfile = asyncHandler(async (req, res) => {
  const profile = await TechnicianProfile.findOne({ userId: req.user._id })
    .populate('serviceCategories', 'name slug baseIndividualPrice estimatedDurationMins')
    .populate('zoneId', 'name code city');

  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  return sendSuccess(res, { data: profile });
});

/**
 * Updates editable fields on the authenticated technician's profile.
 */
export const updateMyTechnicianProfile = asyncHandler(async (req, res) => {
  const profile = await TechnicianProfile.findOne({ userId: req.user._id });
  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  const { baseLocation, addressText, serviceCategories, zoneId, serviceRadiusKm, maxPoolCapacity } =
    req.body || {};

  if (baseLocation !== undefined) {
    profile.baseLocation = parseGeoInput(baseLocation);
  }
  if (addressText !== undefined) {
    profile.addressText = addressText;
  }
  if (serviceRadiusKm !== undefined) {
    profile.serviceRadiusKm = serviceRadiusKm;
  }
  if (maxPoolCapacity !== undefined) {
    profile.maxPoolCapacity = maxPoolCapacity;
  }
  if (zoneId !== undefined) {
    if (zoneId === null) {
      profile.zoneId = null;
    } else {
      if (!mongoose.isValidObjectId(zoneId)) {
        throw new AppError(400, 'Invalid zoneId format.', 'INVALID_ID');
      }
      const zone = await ServiceZone.findOne({ _id: zoneId, isActive: true });
      if (!zone) {
        throw new AppError(404, 'Active service zone not found.', 'ZONE_NOT_FOUND');
      }
      profile.zoneId = zone._id;
    }
  }
  if (serviceCategories !== undefined) {
    if (!Array.isArray(serviceCategories)) {
      throw new AppError(400, 'serviceCategories must be an array of IDs.', 'VALIDATION_ERROR');
    }
    const activeCount = await ServiceCategory.countDocuments({
      _id: { $in: serviceCategories },
      isActive: true,
    });
    if (activeCount !== serviceCategories.length) {
      throw new AppError(400, 'One or more service categories are invalid or inactive.', 'INVALID_CATEGORY');
    }
    profile.serviceCategories = serviceCategories;
  }

  await profile.save();
  await profile.populate('serviceCategories', 'name slug baseIndividualPrice estimatedDurationMins');
  await profile.populate('zoneId', 'name code city');

  return sendSuccess(res, {
    message: 'Technician profile updated.',
    data: profile,
  });
});

/**
 * Toggles availability status and working hours for an approved, active technician.
 */
export const updateMyAvailability = asyncHandler(async (req, res) => {
  const { availabilityStatus, workingHours } = req.body || {};

  if (!AVAILABILITY_STATUSES.includes(availabilityStatus)) {
    throw new AppError(
      400,
      `availabilityStatus must be one of: ${AVAILABILITY_STATUSES.join(', ')}.`,
      'VALIDATION_ERROR'
    );
  }

  // Prevent inactive technician from becoming available
  if (req.user.isActive === false) {
    throw new AppError(403, 'Inactive technicians cannot update availability.', 'ACCOUNT_INACTIVE');
  }

  const profile = await TechnicianProfile.findOne({ userId: req.user._id });
  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  // Prevent unapproved technician or technician with active commitments from becoming available
  if (availabilityStatus === 'available') {
    if (profile.approvalStatus !== 'approved') {
      throw new AppError(
        403,
        'Technician account must be approved by an admin before marking available.',
        'TECH_NOT_APPROVED'
      );
    }

    const activeStatusFilter = { $in: ['assigned', 'accepted', 'arrived', 'in_progress'] };
    const onSiteStatusFilter = { $in: ['arrived', 'in_progress'] };
    const [onSitePools, onSiteBookings, activePools, activeBookings] = await Promise.all([
      ServicePool.countDocuments({ assignedTechnicianId: req.user._id, status: onSiteStatusFilter }),
      Booking.countDocuments({ technicianId: req.user._id, poolId: null, status: onSiteStatusFilter }),
      ServicePool.countDocuments({ assignedTechnicianId: req.user._id, status: activeStatusFilter }),
      Booking.countDocuments({ technicianId: req.user._id, poolId: null, status: activeStatusFilter }),
    ]);

    if (onSitePools + onSiteBookings > 0) {
      throw new AppError(
        409,
        'Cannot set availability to "available" while a service job is in progress or on-site.',
        'ACTIVE_JOB_IN_PROGRESS'
      );
    }
    const maxCap = profile.maxPoolCapacity || 4;
    const currentWorkload = activePools + activeBookings;
    if (currentWorkload >= maxCap) {
      throw new AppError(
        409,
        `Cannot set availability to "available": maximum workload capacity reached (${currentWorkload}/${maxCap}).`,
        'WORKLOAD_CAPACITY_EXCEEDED'
      );
    }
  }

  // Validate and update working hours if provided
  if (workingHours !== undefined) {
    if (typeof workingHours !== 'object' || workingHours === null) {
      throw new AppError(
        400,
        'workingHours must be an object with start, end, and daysOfWeek.',
        'VALIDATION_ERROR'
      );
    }

    const { start, end, daysOfWeek } = workingHours;
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (start !== undefined && !timeRegex.test(start)) {
      throw new AppError(
        400,
        'workingHours.start must be in HH:mm 24-hour format (e.g. "09:00").',
        'VALIDATION_ERROR'
      );
    }
    if (end !== undefined && !timeRegex.test(end)) {
      throw new AppError(
        400,
        'workingHours.end must be in HH:mm 24-hour format (e.g. "18:00").',
        'VALIDATION_ERROR'
      );
    }

    const effectiveStart = start || profile.workingHours?.start || '09:00';
    const effectiveEnd = end || profile.workingHours?.end || '18:00';
    if (effectiveStart >= effectiveEnd) {
      throw new AppError(
        400,
        'workingHours.end must be strictly after workingHours.start.',
        'VALIDATION_ERROR'
      );
    }

    if (daysOfWeek !== undefined) {
      if (
        !Array.isArray(daysOfWeek) ||
        !daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      ) {
        throw new AppError(
          400,
          'workingHours.daysOfWeek must be an array of integers between 0 (Sunday) and 6 (Saturday).',
          'VALIDATION_ERROR'
        );
      }
    }

    profile.workingHours = {
      start: effectiveStart,
      end: effectiveEnd,
      daysOfWeek: daysOfWeek || profile.workingHours?.daysOfWeek || [1, 2, 3, 4, 5, 6],
    };
  }

  profile.availabilityStatus = availabilityStatus;
  await profile.save();

  return sendSuccess(res, {
    message: 'Technician availability updated.',
    data: profile,
  });
});

/**
 * Updates a technician's availability status (Admin oversight).
 */
export const updateTechnicianAvailabilityAdmin = asyncHandler(async (req, res) => {
  const { availabilityStatus, workingHours } = req.body || {};
  if (!AVAILABILITY_STATUSES.includes(availabilityStatus)) {
    throw new AppError(
      400,
      `availabilityStatus must be one of: ${AVAILABILITY_STATUSES.join(', ')}.`,
      'VALIDATION_ERROR'
    );
  }

  const profile = await TechnicianProfile.findById(req.params.id);
  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  if (availabilityStatus === 'available') {
    if (profile.approvalStatus !== 'approved') {
      throw new AppError(
        409,
        'Cannot mark technician available before profile is approved.',
        'TECH_NOT_APPROVED'
      );
    }

    const activeStatusFilter = { $in: ['assigned', 'accepted', 'arrived', 'in_progress'] };
    const onSiteStatusFilter = { $in: ['arrived', 'in_progress'] };
    const [onSitePools, onSiteBookings, activePools, activeBookings] = await Promise.all([
      ServicePool.countDocuments({ assignedTechnicianId: profile.userId, status: onSiteStatusFilter }),
      Booking.countDocuments({ technicianId: profile.userId, poolId: null, status: onSiteStatusFilter }),
      ServicePool.countDocuments({ assignedTechnicianId: profile.userId, status: activeStatusFilter }),
      Booking.countDocuments({ technicianId: profile.userId, poolId: null, status: activeStatusFilter }),
    ]);

    if (onSitePools + onSiteBookings > 0) {
      throw new AppError(
        409,
        'Cannot set availability to "available" while a service job is in progress or on-site.',
        'ACTIVE_JOB_IN_PROGRESS'
      );
    }
    const maxCap = profile.maxPoolCapacity || 4;
    const currentWorkload = activePools + activeBookings;
    if (currentWorkload >= maxCap) {
      throw new AppError(
        409,
        `Cannot set availability to "available": maximum workload capacity reached (${currentWorkload}/${maxCap}).`,
        'WORKLOAD_CAPACITY_EXCEEDED'
      );
    }
  }

  if (workingHours !== undefined) {
    if (typeof workingHours !== 'object' || workingHours === null) {
      throw new AppError(
        400,
        'workingHours must be an object with start, end, and daysOfWeek.',
        'VALIDATION_ERROR'
      );
    }

    const { start, end, daysOfWeek } = workingHours;
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (start !== undefined && !timeRegex.test(start)) {
      throw new AppError(
        400,
        'workingHours.start must be in HH:mm 24-hour format (e.g. "09:00").',
        'VALIDATION_ERROR'
      );
    }
    if (end !== undefined && !timeRegex.test(end)) {
      throw new AppError(
        400,
        'workingHours.end must be in HH:mm 24-hour format (e.g. "18:00").',
        'VALIDATION_ERROR'
      );
    }

    const effectiveStart = start || profile.workingHours?.start || '09:00';
    const effectiveEnd = end || profile.workingHours?.end || '18:00';
    if (effectiveStart >= effectiveEnd) {
      throw new AppError(
        400,
        'workingHours.end must be strictly after workingHours.start.',
        'VALIDATION_ERROR'
      );
    }

    if (daysOfWeek !== undefined) {
      if (
        !Array.isArray(daysOfWeek) ||
        !daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      ) {
        throw new AppError(
          400,
          'workingHours.daysOfWeek must be an array of integers between 0 (Sunday) and 6 (Saturday).',
          'VALIDATION_ERROR'
        );
      }
    }

    profile.workingHours = {
      start: effectiveStart,
      end: effectiveEnd,
      daysOfWeek: daysOfWeek || profile.workingHours?.daysOfWeek || [1, 2, 3, 4, 5, 6],
    };
  }

  profile.availabilityStatus = availabilityStatus;
  await profile.save();

  return sendSuccess(res, {
    message: 'Technician availability updated by admin.',
    data: profile,
  });
});

/**
 * Lists technician profiles with optional validated approval/availability filters (Admin only).
 */
export const listTechniciansAdmin = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  if (req.query.approvalStatus !== undefined) {
    if (!APPROVAL_STATUSES.includes(req.query.approvalStatus)) {
      throw new AppError(
        400,
        `approvalStatus filter must be one of: ${APPROVAL_STATUSES.join(', ')}.`,
        'VALIDATION_ERROR'
      );
    }
    filter.approvalStatus = req.query.approvalStatus;
  }

  if (req.query.availabilityStatus !== undefined) {
    if (!AVAILABILITY_STATUSES.includes(req.query.availabilityStatus)) {
      throw new AppError(
        400,
        `availabilityStatus filter must be one of: ${AVAILABILITY_STATUSES.join(', ')}.`,
        'VALIDATION_ERROR'
      );
    }
    filter.availabilityStatus = req.query.availabilityStatus;
  }

  const [items, total] = await Promise.all([
    TechnicianProfile.find(filter)
      .populate('userId', 'name email phone isActive')
      .populate('serviceCategories', 'name slug')
      .populate('zoneId', 'name code city')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    TechnicianProfile.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    data: items,
    meta: { pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
  });
});

/**
 * Approves or rejects a technician account (Admin only).
 */
export const updateTechnicianApproval = asyncHandler(async (req, res) => {
  const { approvalStatus } = req.body || {};
  if (!APPROVAL_STATUSES.includes(approvalStatus)) {
    throw new AppError(
      400,
      `approvalStatus must be one of: ${APPROVAL_STATUSES.join(', ')}.`,
      'VALIDATION_ERROR'
    );
  }

  const profile = await TechnicianProfile.findById(req.params.id);
  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  profile.approvalStatus = approvalStatus;
  if (approvalStatus !== 'approved') {
    profile.availabilityStatus = 'offline';
  }
  await profile.save();

  await Notification.create({
    userId: profile.userId,
    role: 'technician',
    title: 'Technician Approval Status Updated',
    message: `Your technician profile status is now "${approvalStatus}".`,
    type: 'system',
    relatedEntityId: profile._id,
  });

  return sendSuccess(res, {
    message: 'Technician approval status updated.',
    data: profile,
  });
});
