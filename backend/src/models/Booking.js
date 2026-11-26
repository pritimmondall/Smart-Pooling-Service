import mongoose from 'mongoose';
import { createGeoPointSchema } from '../utils/geo.js';

export const BOOKING_MODES = ['pool', 'individual'];
export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'assigned',
  'accepted',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
];

const bookingSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    specificService: { type: String, maxlength: 100 },
    automaticDispatch: { type: Boolean, default: false },
    poolScope: { type: String, enum: ['building', '200m', '500m', '1km'] },
    buildingKey: { type: String, maxlength: 160 },
    serviceCategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCategory',
      required: true,
    },
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceZone',
      default: null,
    },
    poolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServicePool',
      default: null,
      index: true,
    },
    location: {
      type: createGeoPointSchema(true),
      required: true,
    },
    addressText: {
      type: String,
      required: [true, 'Service address description is required.'],
      trim: true,
      maxlength: [300, 'Address cannot exceed 300 characters.'],
    },
    timeWindow: {
      start: {
        type: Date,
        required: [true, 'Preferred time window start is required.'],
      },
      end: {
        type: Date,
        required: [true, 'Preferred time window end is required.'],
        validate: {
          validator(value) {
            if (!this.timeWindow?.start || !value) return true;
            return value > this.timeWindow.start;
          },
          message: 'Time window end must be strictly after time window start.',
        },
      },
    },
    bookingMode: {
      type: String,
      enum: BOOKING_MODES,
      default: 'pool',
    },
    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: 'pending',
    },
    confirmedMaxFare: { type: Number, min: 0 },
    confirmationSelection: String,
    dispatchDueAt: Date,
    waitingSince: Date,
    departedAt: Date,
    closingPriceLimit: { type: Number, min: 0 },
    acceptedShift: {
      originalStart: Date, originalEnd: Date, acceptedAt: Date,
      bonusPercentage: Number, creditPaise: Number,
    },
    estimatedPrice: {
      type: Number,
      required: true,
      min: [0, 'Estimated price cannot be negative.'],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters.'],
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    arrivedAt: {
      type: Date,
      default: null,
    },
    arrivalLocation: {
      type: createGeoPointSchema(false),
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    routeSavings: {
      provider: String,
      costPerKm: Number,
      customerPaise: Number,
      technicianPaise: Number,
      platformPaise: Number,
    },
    customerConfirmedAt: { type: Date, default: null },
    rejectedTechnicians: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    completedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },
    stopSequence: {
      type: Number,
      default: 0,
    },
    version: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

bookingSchema.index({ location: '2dsphere' });
bookingSchema.index({ poolId: 1, status: 1 });
bookingSchema.index({ technicianId: 1, status: 1 });
bookingSchema.index({ status: 1, serviceCategoryId: 1, 'timeWindow.start': 1 });
bookingSchema.index({ customerId: 1, createdAt: -1 });

export const Booking = mongoose.model('Booking', bookingSchema);
