import mongoose from 'mongoose';

const serviceCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Service category name is required.'],
      trim: true,
      maxlength: 80,
    },
    slug: {
      type: String,
      required: [true, 'Slug is required.'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    baseIndividualPrice: {
      type: Number,
      required: [true, 'Base individual price (INR) is required.'],
      min: [1, 'Base individual price must be positive.'],
    },
    estimatedDurationMins: {
      type: Number,
      required: [true, 'Estimated service duration (minutes) is required.'],
      min: [10, 'Service duration must be at least 10 minutes.'],
      max: [480, 'Service duration cannot exceed 480 minutes.'],
    },
    defaultPoolRadiusKm: {
      type: Number,
      default: 0.2,
      min: [0.2, 'Pool radius must be at least 0.2 km.'],
      max: [25, 'Pool radius cannot exceed 25 km.'],
    },
    maxPoolSize: {
      type: Number,
      default: 4,
      min: [2, 'Maximum pool size must be at least 2.'],
      max: [10, 'Maximum pool size cannot exceed 10.'],
    },
    poolLockCutoffMins: {
      type: Number,
      default: 60,
      min: [10, 'Lock cutoff must be at least 10 minutes before window start.'],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

export const ServiceCategory = mongoose.model('ServiceCategory', serviceCategorySchema);
