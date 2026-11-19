import mongoose from 'mongoose';

/**
 * Lightweight coordinator document used to prevent race-condition creation of
 * duplicate compatible pools within the same spatial-temporal cluster.
 */
const poolClusterLockSchema = new mongoose.Schema(
  {
    lockKey: {
      type: String,
      required: true,
      unique: true,
    },
    serviceCategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCategory',
      required: true,
    },
    dateKey: {
      type: String,
      required: true,
    },
    lastCreatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true, versionKey: false }
);

export const PoolClusterLock = mongoose.model('PoolClusterLock', poolClusterLockSchema);
