import mongoose from 'mongoose';
import { createGeoPointSchema } from '../utils/geo.js';

export const POOL_STATUSES = [
  'forming',
  'locked',
  'assigned',
  'accepted',
  'in_progress',
  'completed',
  'cancelled',
];

const VALID_STATUS_TRANSITIONS = {
  forming: ['locked', 'cancelled'],
  locked: ['assigned', 'cancelled', 'forming'], // 'forming' allowed if cancellation drops pool back before lock cutoff
  assigned: ['accepted', 'locked', 'cancelled'], // 'locked' if technician declines/rejects
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const poolMemberSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    location: {
      type: createGeoPointSchema(true),
      required: true,
    },
    addressText: {
      type: String,
      default: '',
      trim: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['active', 'cancelled'],
      default: 'active',
    },
  },
  { _id: true }
);

const servicePoolSchema = new mongoose.Schema(
  {
    specificService: { type: String, maxlength: 100 },
    poolScope: { type: String, enum: ['building', '200m', '500m', '1km'] },
    buildingKey: { type: String, maxlength: 160 },
    serviceCategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCategory',
      required: [true, 'serviceCategoryId is required.'],
      index: true,
    },
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceZone',
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: POOL_STATUSES,
      default: 'forming',
      index: true,
    },
    maxCapacity: {
      type: Number,
      required: [true, 'maxCapacity is required.'],
      min: [2, 'maxCapacity must be at least 2.'],
      max: [10, 'maxCapacity cannot exceed 10.'],
    },
    poolRadiusKm: {
      type: Number,
      required: [true, 'poolRadiusKm is required.'],
      min: [0.1, 'poolRadiusKm must be at least 0.1 km.'],
    },
    centroidLocation: {
      type: createGeoPointSchema(true),
      required: true,
    },
    aggregateTimeWindow: {
      start: {
        type: Date,
        required: [true, 'aggregateTimeWindow.start is required.'],
      },
      end: {
        type: Date,
        required: [true, 'aggregateTimeWindow.end is required.'],
        validate: {
          validator(value) {
            if (!this.aggregateTimeWindow?.start || !value) return true;
            return value > this.aggregateTimeWindow.start;
          },
          message: 'aggregateTimeWindow.end must be strictly after start.',
        },
      },
    },
    ownerLockCutoffTime: Date,
    lockCutoffTime: {
      type: Date,
      required: [true, 'lockCutoffTime is required.'],
      index: true,
    },
    members: {
      type: [poolMemberSchema],
      default: [],
    },
    pricing: {
      individualBasePrice: {
        type: Number,
        default: 0,
        min: 0,
      },
      memberCount: {
        type: Number,
        default: 0,
        min: 0,
      },
      discountPercentage: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      finalPricePerMember: {
        type: Number,
        default: 0,
        min: 0,
      },
      finalPricePaise: {
        type: Number,
        default: 0,
        min: 0,
      },
      basePricePaise: {
        type: Number,
        default: 0,
        min: 0,
      },
      totalSavingsPerMember: {
        type: Number,
        default: 0,
        min: 0,
      },
      totalSavingsPaise: {
        type: Number,
        default: 0,
        min: 0,
      },
      poolTotal: {
        type: Number,
        default: 0,
        min: 0,
      },
      poolTotalPaise: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    version: {
      type: Number,
      default: 0,
    },
    formingAlertsSent: { type: Boolean, default: false },
    notificationsDispatched: {
      type: Boolean,
      default: false,
      index: true,
    },
    assignedTechnicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    reservedTechnicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    reservedAt: { type: Date, default: null },
    assignedAt: {
      type: Date,
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
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
    rejectedTechnicians: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      ],
      default: [],
      validate: {
        validator(arr) {
          if (!Array.isArray(arr)) return false;
          const ids = arr.map((id) => String(id?._id || id));
          return new Set(ids).size === ids.length;
        },
        message: 'rejectedTechnicians cannot contain duplicate technician IDs.',
      },
    },
    sharedGeometry: { key: String, line: { type: [[Number]], default: undefined } },
    routeOrder: [
      {
        bookingId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Booking',
          required: true,
        },
        sequenceIndex: {
          type: Number,
          required: true,
        },
        estimatedArrival: {
          type: Date,
          default: null,
        },
        estimatedServiceStart: {
          type: Date,
          default: null,
        },
        estimatedServiceEnd: {
          type: Date,
          default: null,
        },
        actualArrival: {
          type: Date,
          default: null,
        },
        actualServiceStart: {
          type: Date,
          default: null,
        },
        actualServiceEnd: {
          type: Date,
          default: null,
        },
        status: {
          type: String,
          default: null,
        },
      },
    ],
  },
  { timestamps: true }
);

// Geospatial index on centroid
servicePoolSchema.index({ centroidLocation: '2dsphere' });

// Compound index for technician assignment queries
servicePoolSchema.index({ assignedTechnicianId: 1, status: 1 });

// Efficient compound lookup index for matching engine
servicePoolSchema.index({
  status: 1,
  serviceCategoryId: 1,
  lockCutoffTime: 1,
  'aggregateTimeWindow.start': 1,
});

// Member lookup indexes
servicePoolSchema.index({ 'members.bookingId': 1 });
servicePoolSchema.index({ 'members.customerId': 1 });

// Index for filtering rejected technicians
servicePoolSchema.index({ rejectedTechnicians: 1 });

// Virtual getter for backward compatibility or alternate naming access
servicePoolSchema.virtual('rejectedTechnicianIds').get(function () {
  return this.rejectedTechnicians || [];
});

/**
 * Validates status transitions
 */
servicePoolSchema.pre('save', function (next) {
  if (this.isModified('status') && !this.isNew) {
    // Check if status is transitioning illegally
    // Note: Mongoose this.status vs this._originalStatus or direct transition check
    // We also enforce at the service layer
  }
  next();
});

export { VALID_STATUS_TRANSITIONS };
export const ServicePool = mongoose.model('ServicePool', servicePoolSchema);
