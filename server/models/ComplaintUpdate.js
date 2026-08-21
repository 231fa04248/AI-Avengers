import mongoose from 'mongoose';

const complaintUpdateSchema = new mongoose.Schema({
  complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['status', 'note', 'assignment', 'ai', 'escalation', 'system'], default: 'note' },
  status: String,
  message: { type: String, required: true },
  images: [{ url: String, originalName: String }]
}, { timestamps: true });

export default mongoose.model('ComplaintUpdate', complaintUpdateSchema);

