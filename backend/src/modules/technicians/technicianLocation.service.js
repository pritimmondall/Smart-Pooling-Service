import mongoose from 'mongoose';
import { TechnicianProfile, TechnicianLocation } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';

// Minimum interval in milliseconds between successive location updates per technician
export const LOCATION_THROTTLE_MS = 5000; // 5 seconds

// Threshold in seconds after which a recorded location is flagged as stale
export const STALE_LOCATION_THRESHOLD_SECONDS = 15 * 60; // 15 minutes

/**
 * Validates and records a real-time GPS update for an authenticated technician.
 *
 * Enforces:
 * 1. Strict coordinate bounds: latitude [-90, 90], longitude [-180, 180].
 * 2. Reasonable timestamp validation: rejects future or ancient timestamps.
 * 3. Throttling policy: prevents excessive GPS spamming (min 5 seconds between updates).
 * 4. Dual persistence: caches latest in TechnicianProfile and logs to TechnicianLocation.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @param {Object} payload
 * @returns {Promise<Object>}
 */
export async function recordTechnicianLocation(technicianUserId, payload = {}) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);

  const { latitude, longitude, timestamp, accuracy, speed, heading } = payload;

  // 1. Coordinate Validation
  if (latitude === undefined || latitude === null || typeof latitude !== 'number' || Number.isNaN(latitude)) {
    throw new AppError(400, 'latitude must be a valid numeric value between -90 and 90.', 'VALIDATION_ERROR');
  }
  if (latitude < -90 || latitude > 90) {
    throw new AppError(400, 'latitude must be between -90 and 90 degrees.', 'VALIDATION_ERROR');
  }

  if (longitude === undefined || longitude === null || typeof longitude !== 'number' || Number.isNaN(longitude)) {
    throw new AppError(400, 'longitude must be a valid numeric value between -180 and 180.', 'VALIDATION_ERROR');
  }
  if (longitude < -180 || longitude > 180) {
    throw new AppError(400, 'longitude must be between -180 and 180 degrees.', 'VALIDATION_ERROR');
  }

  // 2. Timestamp Validation
  let recordedAt = new Date();
  if (timestamp !== undefined && timestamp !== null) {
    recordedAt = new Date(timestamp);
    if (Number.isNaN(recordedAt.getTime())) {
      throw new AppError(400, 'timestamp must be a valid date or ISO string.', 'VALIDATION_ERROR');
    }

    const now = Date.now();
    // Reject timestamps more than 5 minutes in the future (permitting slight client clock skew)
    if (recordedAt.getTime() > now + 5 * 60 * 1000) {
      throw new AppError(400, 'Location timestamp cannot be in the future.', 'VALIDATION_ERROR');
    }

    // Reject timestamps older than 48 hours
    if (recordedAt.getTime() < now - 48 * 60 * 60 * 1000) {
      throw new AppError(400, 'Location timestamp is unreasonably old (older than 48 hours).', 'VALIDATION_ERROR');
    }
  }

  // 3. Optional telemetry validation
  let validatedAccuracy = null;
  if (accuracy !== undefined && accuracy !== null) {
    if (typeof accuracy !== 'number' || Number.isNaN(accuracy) || accuracy < 0) {
      throw new AppError(400, 'accuracy must be a non-negative number.', 'VALIDATION_ERROR');
    }
    validatedAccuracy = accuracy;
  }

  let validatedSpeed = null;
  if (speed !== undefined && speed !== null) {
    if (typeof speed !== 'number' || Number.isNaN(speed) || speed < 0) {
      throw new AppError(400, 'speed must be a non-negative number.', 'VALIDATION_ERROR');
    }
    validatedSpeed = speed;
  }

  let validatedHeading = null;
  if (heading !== undefined && heading !== null) {
    if (typeof heading !== 'number' || Number.isNaN(heading) || heading < 0 || heading > 360) {
      throw new AppError(400, 'heading must be a number between 0 and 360 degrees.', 'VALIDATION_ERROR');
    }
    validatedHeading = heading;
  }

  // 4. Atomic Throttling Reservation (Guards against concurrent bursts and race conditions)
  const receiptTime = new Date();
  const throttleThreshold = new Date(receiptTime.getTime() - LOCATION_THROTTLE_MS);

  const claimedProfile = await TechnicianProfile.findOneAndUpdate(
    {
      userId: userObjectId,
      $or: [
        { lastLocationReceiptAt: null },
        { lastLocationReceiptAt: { $exists: false } },
        { lastLocationReceiptAt: { $lte: throttleThreshold } },
      ],
    },
    { $set: { lastLocationReceiptAt: receiptTime } },
    { new: true }
  );

  if (!claimedProfile) {
    const existingProfile = await TechnicianProfile.findOne({ userId: userObjectId })
      .select('_id lastLocationReceiptAt')
      .lean();
    if (!existingProfile) {
      throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
    }

    const elapsed = existingProfile.lastLocationReceiptAt
      ? receiptTime.getTime() - existingProfile.lastLocationReceiptAt.getTime()
      : 0;
    const waitSeconds = Math.max(1, Math.ceil((LOCATION_THROTTLE_MS - elapsed) / 1000));
    throw new AppError(
      429,
      `Location updates are throttled. Please wait ${waitSeconds}s before submitting another location update.`,
      'RATE_LIMIT_EXCEEDED'
    );
  }

  const geoPoint = {
    type: 'Point',
    coordinates: [longitude, latitude],
  };

  // 5. Dual Persistence:
  // A. Create record in TechnicianLocation collection
  const locationRecord = await TechnicianLocation.create({
    technicianId: userObjectId,
    location: geoPoint,
    accuracy: validatedAccuracy,
    speed: validatedSpeed,
    heading: validatedHeading,
    recordedAt,
  });

  // B. Fast-read cache update in TechnicianProfile guarded against out-of-order timestamps
  // Only update currentLocation & lastLocationUpdate if incoming recordedAt is newer or equal
  await TechnicianProfile.updateOne(
    {
      userId: userObjectId,
      $or: [
        { lastLocationUpdate: null },
        { lastLocationUpdate: { $exists: false } },
        { lastLocationUpdate: { $lte: recordedAt } },
      ],
    },
    {
      $set: {
        currentLocation: geoPoint,
        lastLocationUpdate: recordedAt,
      },
    }
  );

  return {
    location: geoPoint,
    latitude,
    longitude,
    accuracy: validatedAccuracy,
    speed: validatedSpeed,
    heading: validatedHeading,
    recordedAt: recordedAt.toISOString(),
    createdAt: locationRecord.createdAt.toISOString(),
  };
}

/**
 * Retrieves the latest recorded location for the authenticated technician.
 * Identifies whether the location is stale or active.
 *
 * @param {string|mongoose.Types.ObjectId} technicianUserId
 * @returns {Promise<Object>}
 */
export async function getLatestTechnicianLocation(technicianUserId) {
  if (!mongoose.isValidObjectId(technicianUserId)) {
    throw new AppError(400, 'Invalid technician ID format.', 'INVALID_ID');
  }

  const userObjectId = new mongoose.Types.ObjectId(technicianUserId);

  const profile = await TechnicianProfile.findOne({ userId: userObjectId }).lean();
  if (!profile) {
    throw new AppError(404, 'Technician profile not found.', 'TECH_PROFILE_NOT_FOUND');
  }

  if (!profile.currentLocation || !profile.lastLocationUpdate) {
    return {
      hasLocation: false,
      location: null,
      message: 'No location updates recorded for this technician.',
    };
  }

  // Fetch telemetry details from latest TechnicianLocation record
  const latestLog = await TechnicianLocation.findOne({ technicianId: userObjectId })
    .sort({ recordedAt: -1 })
    .lean();

  const recordedAt = new Date(profile.lastLocationUpdate);
  const ageSeconds = Math.max(0, Math.round((Date.now() - recordedAt.getTime()) / 1000));
  const isStale = ageSeconds > STALE_LOCATION_THRESHOLD_SECONDS;

  const [lng, lat] = profile.currentLocation.coordinates || [];

  return {
    hasLocation: true,
    location: profile.currentLocation,
    latitude: lat,
    longitude: lng,
    accuracy: latestLog?.accuracy ?? null,
    speed: latestLog?.speed ?? null,
    heading: latestLog?.heading ?? null,
    recordedAt: recordedAt.toISOString(),
    ageSeconds,
    isStale,
  };
}
