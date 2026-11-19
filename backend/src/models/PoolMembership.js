import mongoose from 'mongoose';

export const MEMBERSHIP_STATUSES = ['active', 'cancelled'];

const poolMembershipSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
    poolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServicePool',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: MEMBERSHIP_STATUSES,
      default: 'active',
      index: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Database-level uniqueness: A booking can NEVER have more than one 'active' pool membership
poolMembershipSchema.index(
  { bookingId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
  }
);

poolMembershipSchema.index({ poolId: 1, status: 1 });
poolMembershipSchema.index({ customerId: 1, status: 1 });

export const PoolMembership = mongoose.model('PoolMembership', poolMembershipSchema);
