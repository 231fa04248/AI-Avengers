import mongoose from 'mongoose';
import { CATEGORIES, PRIORITIES, STATUSES } from '../utils/constants.js';

const locationSchema = new mongoose.Schema({
  address: { type: String, default: 'Location pending' },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true }
}, { _id: false });

const complaintSchema = new mongoose.Schema({
  complaintId: { type: String, required: true, unique: true },
  citizen: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, required: true, maxlength: 5000 },
  images: [{ url: String, originalName: String, mimeType: String }],
  location: { type: locationSchema, required: true },
  category: { type: String, enum: CATEGORIES, default: 'Other' },
  aiSummary: String,
  aiConfidence: { type: Number, min: 0, max: 1 },
  priority: { type: String, enum: PRIORITIES, default: 'Medium' },
  priorityScore: { type: Number, default: 0 },
  urgency: { type: Number, default: 0 },
  severity: { type: Number, default: 0 },
  safetyRisk: { type: Number, default: 0 },
  impactScore: { type: Number, default: 0 },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  assignedTeam: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  assignedWorker: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: STATUSES, default: 'Submitted' },
  duplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint' },
  duplicateScore: { type: Number, min: 0, max: 1 },
  duplicateGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DuplicateGroup' },
  affectedCitizens: { type: Number, default: 1 },
  deadline: Date,
  resolutionNotes: String,
  resolvedAt: Date,
  closedAt: Date,
  aiReasoning: String,
  aiProcessedAt: Date
}, { timestamps: true });

complaintSchema.index({ 'location.latitude': 1, 'location.longitude': 1 });
complaintSchema.index({ status: 1, priority: 1, department: 1 });
complaintSchema.index({ title: 'text', description: 'text' });

export default mongoose.model('Complaint', complaintSchema);

