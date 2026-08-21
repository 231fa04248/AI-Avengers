import mongoose from 'mongoose';

const escalationSchema = new mongoose.Schema({
  complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', required: true },
  level: { type: Number, required: true, min: 1, max: 3 },
  reason: { type: String, required: true },
  escalatedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolvedAt: Date
}, { timestamps: true });

escalationSchema.index({ complaint: 1, level: 1 }, { unique: true });

export default mongoose.model('Escalation', escalationSchema);

