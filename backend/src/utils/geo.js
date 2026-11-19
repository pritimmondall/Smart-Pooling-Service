import mongoose from 'mongoose';
import { AppError } from './appError.js';

const EARTH_RADIUS_KM = 6371;

/**
 * Validates latitude and longitude numeric bounds.
 * Throws 400 AppError on non-numeric or out-of-range coordinates.
 */
export function validateCoordinates(lat, lng) {
  const numLat = Number(lat);
  const numLng = Number(lng);

  if (!Number.isFinite(numLat) || numLat < -90 || numLat > 90) {
    throw new AppError(400, 'Latitude must be a finite number between -90 and 90.', 'INVALID_COORDINATES');
  }
  if (!Number.isFinite(numLng) || numLng < -180 || numLng > 180) {
    throw new AppError(400, 'Longitude must be a finite number between -180 and 180.', 'INVALID_COORDINATES');
  }

  return { lat: numLat, lng: numLng };
}

/**
 * Converts { lat, lng } into MongoDB GeoJSON Point ([longitude, latitude] axis order).
 */
export function toGeoJSONPoint(lat, lng) {
  const valid = validateCoordinates(lat, lng);
  return {
    type: 'Point',
    coordinates: [valid.lng, valid.lat],
  };
}

/**
 * Accepts either { lat, lng } or GeoJSON { type: 'Point', coordinates: [lng, lat] }
 * and normalizes into a validated GeoJSON Point.
 */
export function parseGeoInput(input) {
  if (!input || typeof input !== 'object') {
    throw new AppError(400, 'Location coordinates are required.', 'INVALID_COORDINATES');
  }

  if (input.type === 'Point' && Array.isArray(input.coordinates) && input.coordinates.length === 2) {
    const [lng, lat] = input.coordinates;
    return toGeoJSONPoint(lat, lng);
  }

  if (input.lat !== undefined && input.lng !== undefined) {
    return toGeoJSONPoint(input.lat, input.lng);
  }

  throw new AppError(
    400,
    'Location must provide { lat, lng } or GeoJSON Point { type: "Point", coordinates: [lng, lat] }.',
    'INVALID_COORDINATES'
  );
}

/**
 * Converts a MongoDB GeoJSON Point ([lng, lat]) into Leaflet-friendly { lat, lng }.
 */
export function fromGeoJSONPoint(point) {
  if (!point || point.type !== 'Point' || !Array.isArray(point.coordinates) || point.coordinates.length !== 2) {
    throw new AppError(500, 'Invalid GeoJSON Point stored in document.', 'INVALID_GEOJSON');
  }
  const [lng, lat] = point.coordinates;
  return { lat, lng };
}

/**
 * Computes straight-line spherical (Haversine) distance in kilometers between two { lat, lng } or GeoJSON points.
 * NOTE: Straight-line distance only — NOT road network distance (road distances are handled in Phase 5).
 */
export function haversineDistanceKm(pointA, pointB) {
  const a = pointA?.type === 'Point' ? fromGeoJSONPoint(pointA) : validateCoordinates(pointA?.lat, pointA?.lng);
  const b = pointB?.type === 'Point' ? fromGeoJSONPoint(pointB) : validateCoordinates(pointB?.lat, pointB?.lng);

  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Reusable Mongoose subschema for a GeoJSON Point ([longitude, latitude]).
 */
export function createGeoPointSchema(required = true) {
  return new mongoose.Schema(
    {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
        required,
      },
      coordinates: {
        type: [Number],
        required,
        validate: {
          validator(coords) {
            if (!required && (!coords || coords.length === 0)) return true;
            if (!Array.isArray(coords) || coords.length !== 2) return false;
            const [lng, lat] = coords;
            return (
              Number.isFinite(lng) &&
              lng >= -180 &&
              lng <= 180 &&
              Number.isFinite(lat) &&
              lat >= -90 &&
              lat <= 90
            );
          },
          message: 'GeoJSON coordinates must be [longitude, latitude] within valid bounds.',
        },
      },
    },
    { _id: false }
  );
}
