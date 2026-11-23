import mongoose from 'mongoose';
import { createGeoPointSchema } from '../utils/geo.js';

const schema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  serviceCategoryId: { type: mongoose.Schema.Types.ObjectId, required: true },
  specificService: { type: String, required: true },
  location: { type: createGeoPointSchema(true), required: true },
  start: { type: Date, required: true },
  end: { type: Date, required: true },
  maxPrice: { type: Number, required: true },
});
schema.index({ end: 1 }, { expireAfterSeconds: 0 });
export const PoolWatch = mongoose.model('PoolWatch', schema);
