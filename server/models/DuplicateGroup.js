import mongoose from 'mongoose';

const duplicateGroupSchema = new mongoose.Schema({
  canonicalComplaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', required: true },
  complaints: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Complaint' }],
  category: String,
  centroid: { latitude: Number, longitude: Number },
  affectedCitizens: { type: Number, default: 1 },
  override: { type: Boolean, default: false },
  overrideReason: String
}, { timestamps: true });

export default mongoose.model('DuplicateGroup', duplicateGroupSchema);

