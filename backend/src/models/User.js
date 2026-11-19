import mongoose from 'mongoose';
import { createGeoPointSchema } from '../utils/geo.js';
import bcrypt from 'bcryptjs';

export const USER_ROLES = ['customer', 'technician', 'admin'];

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required.'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters.'],
      maxlength: [100, 'Name cannot exceed 100 characters.'],
    },
    email: {
      type: String,
      required: [true, 'Email is required.'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address.'],
    },
    poolAlertLocation: { type: createGeoPointSchema(), default: undefined },
    phone: {
      type: String,
      trim: true,
      maxlength: [20, 'Phone number cannot exceed 20 characters.'],
    },
    passwordHash: {
      type: String,
      required: [true, 'Password is required.'],
      minlength: [6, 'Password must be at least 6 characters.'],
      select: false,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
      default: 'customer',
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

userSchema.index({ poolAlertLocation: '2dsphere' });

userSchema.pre('save', async function hashPasswordIfModified(next) {
  if (!this.isModified('passwordHash')) {
    return next();
  }
  if (String(this.passwordHash).length < 6) {
    return next(new Error('Password must be at least 6 characters.'));
  }
  const salt = await bcrypt.genSalt(10);
  this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  next();
});

/**
 * Compares a plaintext password candidate against the stored bcrypt hash.
 */
userSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

export const User = mongoose.model('User', userSchema);
