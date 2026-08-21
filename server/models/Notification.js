import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint' },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['info', 'success', 'warning', 'critical'], default: 'info' },
  readAt: Date
}, { timestamps: true });

export default mongoose.model('Notification', notificationSchema);

