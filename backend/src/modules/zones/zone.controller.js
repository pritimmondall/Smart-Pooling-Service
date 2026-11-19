import { ServiceZone } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parseGeoInput, validateCoordinates } from '../../utils/geo.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Lists active service zones, optionally ordered by proximity using 2dsphere $nearSphere.
 */
export const listActiveZones = asyncHandler(async (req, res) => {
  const { lat, lng, radiusKm } = req.query;

  if (lat !== undefined || lng !== undefined) {
    const coords = validateCoordinates(lat, lng);
    const maxDistanceMeters = (Number(radiusKm) > 0 ? Number(radiusKm) : 25) * 1000;

    const zones = await ServiceZone.find({
      isActive: true,
      centerLocation: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [coords.lng, coords.lat] },
          $maxDistance: maxDistanceMeters,
        },
      },
    });

    return sendSuccess(res, { data: zones, meta: { count: zones.length } });
  }

  const zones = await ServiceZone.find({ isActive: true }).sort({ name: 1 });
  return sendSuccess(res, { data: zones, meta: { count: zones.length } });
});

/**
 * Fetches a single service zone by ID.
 */
export const getZoneById = asyncHandler(async (req, res) => {
  const zone = await ServiceZone.findById(req.params.id);
  if (!zone) {
    throw new AppError(404, 'Service zone not found.', 'ZONE_NOT_FOUND');
  }
  return sendSuccess(res, { data: zone });
});

/**
 * Creates a new geographic service zone (Admin only).
 */
export const createZone = asyncHandler(async (req, res) => {
  const { name, code, city, centerLocation, radiusKm } = req.body || {};
  const parsedCenter = parseGeoInput(centerLocation);

  const zone = await ServiceZone.create({
    name,
    code: String(code || '').trim().toUpperCase(),
    ...(city !== undefined ? { city } : {}),
    centerLocation: parsedCenter,
    ...(radiusKm !== undefined ? { radiusKm } : {}),
  });

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Service zone created.',
    data: zone,
  });
});

/**
 * Updates a service zone (Admin only).
 */
export const updateZone = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const updates = {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.code !== undefined) updates.code = String(body.code).trim().toUpperCase();
  if (body.city !== undefined) updates.city = body.city;
  if (body.radiusKm !== undefined) updates.radiusKm = body.radiusKm;
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  if (body.centerLocation !== undefined) {
    updates.centerLocation = parseGeoInput(body.centerLocation);
  }

  const zone = await ServiceZone.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });

  if (!zone) {
    throw new AppError(404, 'Service zone not found.', 'ZONE_NOT_FOUND');
  }

  return sendSuccess(res, {
    message: 'Service zone updated.',
    data: zone,
  });
});
