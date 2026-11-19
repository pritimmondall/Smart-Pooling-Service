import mongoose from 'mongoose';

const ratingSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: [true, 'Booking reference is required.'],
      unique: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Customer reference is required.'],
      index: true,
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Technician reference is required.'],
      index: true,
    },
    rating: {
      type: Number,
      required: [true, 'Rating value is required.'],
      min: [1, 'Rating must be at least 1 star.'],
      max: [5, 'Rating cannot exceed 5 stars.'],
      validate: {
        validator: Number.isInteger,
        message: 'Rating must be an integer between 1 and 5.',
      },
    },
    comment: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Comment cannot exceed 500 characters.'],
    },
  },
  { timestamps: true }
);

// Compound indexes for performant sorting, filtering and pagination
ratingSchema.index({ technicianId: 1, createdAt: -1 });
ratingSchema.index({ customerId: 1, createdAt: -1 });
ratingSchema.index({ technicianId: 1, rating: 1 });

export const Rating = mongoose.model('Rating', ratingSchema);
export default Rating;
