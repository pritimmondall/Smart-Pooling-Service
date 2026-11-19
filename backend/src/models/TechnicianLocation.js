import mongoose from 'mongoose';
import { createGeoPointSchema } from '../utils/geo.js';

const technicianLocationSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    location: {
      type: createGeoPointSchema(true),
      required: true,
    },
    accuracy: {
      type: Number,
      min: [0, 'Accuracy cannot be negative.'],
      default: null,
    },
    speed: {
      type: Number,
      min: [0, 'Speed cannot be negative.'],
      default: null,
    },
    heading: {
      type: Number,
      min: [0, 'Heading must be between 0 and 360 degrees.'],
      max: [360, 'Heading must be between 0 and 360 degrees.'],
      default: null,
    },
    recordedAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Geospatial index for nearby queries
technicianLocationSchema.index({ location: '2dsphere' });

// Compound index for fast retrieval of latest locations by technician
technicianLocationSchema.index({ technicianId: 1, recordedAt: -1 });

// TTL index to automatically purge historical location data after 30 days (prevents unbounded storage growth)
technicianLocationSchema.index({ recordedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const TechnicianLocation = mongoose.model('TechnicianLocation', technicianLocationSchema);
