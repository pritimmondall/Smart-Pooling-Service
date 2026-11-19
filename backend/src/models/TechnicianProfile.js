import mongoose from 'mongoose';
import { createGeoPointSchema } from '../utils/geo.js';

export const AVAILABILITY_STATUSES = ['available', 'busy', 'offline', 'unavailable'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];

const workingHoursSchema = new mongoose.Schema(
  {
    start: {
      type: String,
      default: '09:00',
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Working hours start must be in HH:mm 24-hour format.'],
    },
    end: {
      type: String,
      default: '18:00',
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Working hours end must be in HH:mm 24-hour format.'],
    },
    daysOfWeek: {
      type: [Number],
      default: [1, 2, 3, 4, 5, 6], // 0=Sunday, 1=Monday, ..., 6=Saturday
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        },
        message: 'daysOfWeek must be an array of integers between 0 (Sunday) and 6 (Saturday).',
      },
    },
  },
  { _id: false }
);

const technicianProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    serviceCategories: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServiceCategory',
      },
    ],
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceZone',
      default: null,
    },
    baseLocation: {
      type: createGeoPointSchema(true),
      required: true,
    },
    currentLocation: {
      type: createGeoPointSchema(false),
      default: null,
    },
    lastLocationUpdate: {
      type: Date,
      default: null,
    },
    lastLocationReceiptAt: {
      type: Date,
      default: null,
    },
    addressText: {
      type: String,
      trim: true,
      maxlength: 250,
    },
    serviceRadiusKm: {
      type: Number,
      default: 10,
      min: [1, 'Service radius must be at least 1 km.'],
      max: [50, 'Service radius cannot exceed 50 km.'],
    },
    maxPoolCapacity: {
      type: Number,
      default: 4,
      min: [1, 'Capacity must be at least 1.'],
      max: [10, 'Capacity cannot exceed 10.'],
    },
    workingHours: {
      type: workingHoursSchema,
      default: () => ({}),
    },
    availabilityStatus: {
      type: String,
      enum: AVAILABILITY_STATUSES,
      default: 'offline',
    },
    approvalStatus: {
      type: String,
      enum: APPROVAL_STATUSES,
      default: 'pending',
    },
    ratingAvg: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    ratingCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    jobsCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },
    version: {
      type: Number,
      default: 0,
    },
    activeWorkload: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

technicianProfileSchema.index({ baseLocation: '2dsphere' });
technicianProfileSchema.index({ availabilityStatus: 1, approvalStatus: 1 });

export const TechnicianProfile = mongoose.model('TechnicianProfile', technicianProfileSchema);
