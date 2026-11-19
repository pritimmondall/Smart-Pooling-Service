import { serviceOptions, poolScopes } from '../pools/poolOptions.js';
import { ServiceCategory } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

function toSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Lists active service categories for public and customer catalog views.
 */
export const listActiveServices = asyncHandler(async (_req, res) => {
  const services = await ServiceCategory.find({ isActive: true }).sort({ name: 1 });
  return sendSuccess(res, {
    data: services.map(service => ({ ...service.toObject(), ...serviceOptions(service) })),
    meta: { count: services.length, poolScopes },
  });
});

/**
 * Lists all service categories including inactive ones (Admin only).
 */
export const listAllServicesAdmin = asyncHandler(async (_req, res) => {
  const services = await ServiceCategory.find().sort({ createdAt: -1 });
  return sendSuccess(res, {
    data: services,
    meta: { count: services.length },
  });
});

/**
 * Fetches a single service category by ID.
 */
export const getServiceById = asyncHandler(async (req, res) => {
  const service = await ServiceCategory.findById(req.params.id);
  if (!service) {
    throw new AppError(404, 'Service category not found.', 'SERVICE_NOT_FOUND');
  }
  return sendSuccess(res, { data: service });
});

/**
 * Creates a new service category (Admin only).
 */
export const createService = asyncHandler(async (req, res) => {
  const {
    name,
    slug,
    description,
    baseIndividualPrice,
    estimatedDurationMins,
    defaultPoolRadiusKm,
    maxPoolSize,
    poolLockCutoffMins,
  } = req.body || {};

  const computedSlug = toSlug(slug || name);
  if (!computedSlug) {
    throw new AppError(400, 'A valid service name or slug is required.', 'VALIDATION_ERROR');
  }

  const service = await ServiceCategory.create({
    name,
    slug: computedSlug,
    description,
    baseIndividualPrice,
    estimatedDurationMins,
    ...(defaultPoolRadiusKm !== undefined ? { defaultPoolRadiusKm } : {}),
    ...(maxPoolSize !== undefined ? { maxPoolSize } : {}),
    ...(poolLockCutoffMins !== undefined ? { poolLockCutoffMins } : {}),
  });

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Service category created.',
    data: service,
  });
});

/**
 * Updates an existing service category (Admin only).
 */
export const updateService = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const allowedFields = [
    'name',
    'description',
    'baseIndividualPrice',
    'estimatedDurationMins',
    'defaultPoolRadiusKm',
    'maxPoolSize',
    'poolLockCutoffMins',
    'isActive',
  ];

  const updates = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  if (body.slug !== undefined) {
    updates.slug = toSlug(body.slug);
  }

  const service = await ServiceCategory.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });

  if (!service) {
    throw new AppError(404, 'Service category not found.', 'SERVICE_NOT_FOUND');
  }

  return sendSuccess(res, {
    message: 'Service category updated.',
    data: service,
  });
});

/**
 * Soft-deactivates a service category so historical bookings retain references (Admin only).
 */
export const deactivateService = asyncHandler(async (req, res) => {
  const service = await ServiceCategory.findByIdAndUpdate(
    req.params.id,
    { isActive: false },
    { new: true }
  );

  if (!service) {
    throw new AppError(404, 'Service category not found.', 'SERVICE_NOT_FOUND');
  }

  return sendSuccess(res, {
    message: 'Service category deactivated.',
    data: service,
  });
});
