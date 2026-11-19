import mongoose from 'mongoose';
import { createGeoPointSchema } from '../utils/geo.js';

const serviceZoneSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Zone name is required.'],
      trim: true,
      maxlength: [100, 'Zone name cannot exceed 100 characters.'],
    },
    code: {
      type: String,
      required: [true, 'Zone code is required.'],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [30, 'Zone code cannot exceed 30 characters.'],
    },
    city: {
      type: String,
      required: [true, 'City is required.'],
      trim: true,
      default: 'Kolkata',
      maxlength: [80, 'City cannot exceed 80 characters.'],
    },
    centerLocation: {
      type: createGeoPointSchema(true),
      required: true,
    },
    radiusKm: {
      type: Number,
      default: 3,
      min: [0.5, 'Zone radius must be at least 0.5 km.'],
      max: [50, 'Zone radius cannot exceed 50 km.'],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

serviceZoneSchema.index({ centerLocation: '2dsphere' });

export const ServiceZone = mongoose.model('ServiceZone', serviceZoneSchema);
