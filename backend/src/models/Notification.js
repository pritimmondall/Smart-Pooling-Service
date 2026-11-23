import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: ['customer', 'technician', 'admin'],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    type: {
      type: String,
      enum: ['booking', 'pool', 'dispatch', 'execution', 'system', 'opportunity'],
      default: 'system',
    },
    invitation: {
      serviceCategoryId: mongoose.Schema.Types.ObjectId,
      lat: Number, lng: Number, fromWatch: Boolean,
      start: Date,
      end: Date,
    },
    relatedEntityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    deliveryChannel: {
      type: String,
      enum: ['in_app'],
      default: 'in_app',
    },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

notificationSchema.index({ userId: 1, relatedEntityId: 1, type: 1 }, {
  unique: true, partialFilterExpression: { type: 'opportunity' },
});

export const Notification = mongoose.model('Notification', notificationSchema);
