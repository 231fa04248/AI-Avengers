import Complaint from '../models/Complaint.js';
import ComplaintUpdate from '../models/ComplaintUpdate.js';
import Department from '../models/Department.js';
import DuplicateGroup from '../models/DuplicateGroup.js';
import User from '../models/User.js';
import { analyzeComplaint } from './aiService.js';
import { notify, notifyMany } from './notificationService.js';
import { getDeadline } from '../utils/priority.js';
import { nextComplaintId } from '../utils/ids.js';

export async function createTimeline({ complaint, author, type, message, status, images }) {
  return ComplaintUpdate.create({ complaint, author, type, message, status, images });
}

async function createComplaintId() {
  const year = new Date().getFullYear();
  const latest = await Complaint.findOne({ complaintId: new RegExp(`^CIV-${year}-`) }).sort({ complaintId: -1 }).select('complaintId').lean();
  const sequence = latest ? Number(latest.complaintId.split('-').at(-1)) + 1 : 1;
  return nextComplaintId(sequence);
}

async function routeDepartment(name) {
  return Department.findOne({ name, isActive: true });
}

export async function processComplaint(complaint) {
  const analysis = await analyzeComplaint({ title: complaint.title, description: complaint.description, category: complaint.category });
  const department = await routeDepartment(analysis.department);
  complaint.category = analysis.category;
  complaint.aiSummary = analysis.summary;
  complaint.aiConfidence = analysis.confidence;
  complaint.priority = analysis.priority;
  complaint.priorityScore = analysis.priorityScore;
  complaint.urgency = analysis.urgency;
  complaint.severity = analysis.severity;
  complaint.safetyRisk = analysis.safetyRisk;
  complaint.impactScore = analysis.impactScore;
  complaint.aiReasoning = analysis.reasoning;
  complaint.department = department?._id;
  complaint.deadline = getDeadline(analysis.priority, complaint.createdAt);
  complaint.status = 'Assigned';
  complaint.aiProcessedAt = new Date();
  await complaint.save();

  await createTimeline({ complaint: complaint._id, author: complaint.citizen, type: 'ai', status: 'Assigned', message: `AI analysis complete. Routed to ${department?.name || analysis.department}.` });
  await notify({ recipient: complaint.citizen, complaint: complaint._id, title: 'Complaint analysed', message: `${complaint.complaintId} is now routed to ${department?.name || 'the civic team'}.`, type: 'success' });
  if (department?.officer) await notify({ recipient: department.officer, complaint: complaint._id, title: 'New complaint routed', message: `${complaint.complaintId} needs departmental review.`, type: 'info' });
  return complaint;
}

export async function findDuplicate(complaint) {
  const threshold = Number(process.env.DUPLICATE_THRESHOLD || 0.8);
  const candidates = await Complaint.find({
    _id: { $ne: complaint._id },
    category: complaint.category,
    'location.latitude': { $gte: complaint.location.latitude - 0.01, $lte: complaint.location.latitude + 0.01 },
    'location.longitude': { $gte: complaint.location.longitude - 0.01, $lte: complaint.location.longitude + 0.01 },
    createdAt: { $gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 90) }
  }).sort({ createdAt: 1 }).limit(50);
  const words = new Set(`${complaint.title} ${complaint.description}`.toLowerCase().split(/\W+/).filter(Boolean));
  let best = null;
  for (const candidate of candidates) {
    const candidateWords = new Set(`${candidate.title} ${candidate.description}`.toLowerCase().split(/\W+/).filter(Boolean));
    const union = new Set([...words, ...candidateWords]);
    const intersection = [...words].filter((word) => candidateWords.has(word)).length;
    const textScore = union.size ? intersection / union.size : 0;
    const distance = Math.hypot(complaint.location.latitude - candidate.location.latitude, complaint.location.longitude - candidate.location.longitude);
    const locationScore = Math.max(0, 1 - distance / 0.01);
    const score = textScore * 0.5 + locationScore * 0.3 + (candidate.category === complaint.category ? 0.2 : 0);
    if (!best || score > best.score) best = { candidate, score };
  }
  if (!best || best.score < threshold) return null;
  let group = best.candidate.duplicateGroup ? await DuplicateGroup.findById(best.candidate.duplicateGroup) : null;
  if (!group) group = await DuplicateGroup.create({ canonicalComplaint: best.candidate._id, complaints: [best.candidate._id], category: complaint.category, centroid: best.candidate.location });
  complaint.duplicateOf = best.candidate._id;
  complaint.duplicateScore = best.score;
  complaint.duplicateGroup = group._id;
  best.candidate.duplicateGroup = group._id;
  best.candidate.affectedCitizens = (best.candidate.affectedCitizens || 1) + 1;
  await Promise.all([complaint.save(), best.candidate.save(), DuplicateGroup.findByIdAndUpdate(group._id, { $addToSet: { complaints: complaint._id }, $inc: { affectedCitizens: 1 } })]);
  const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
  await notifyMany(admins.map((user) => user._id), { complaint: complaint._id, title: 'Possible duplicate complaint', message: `${complaint.complaintId} resembles ${best.candidate.complaintId}.`, type: 'warning' });
  return { original: best.candidate, score: best.score };
}

export async function createComplaint({ data, citizen, files = [] }) {
  const complaint = await Complaint.create({
    ...data,
    complaintId: await createComplaintId(),
    citizen: citizen._id,
    status: 'AI Processing',
    location: typeof data.location === 'string' ? JSON.parse(data.location) : data.location,
    images: files.map((file) => ({ url: `/uploads/${file.filename}`, originalName: file.originalname, mimeType: file.mimetype }))
  });
  await createTimeline({ complaint: complaint._id, author: citizen._id, type: 'system', status: 'AI Processing', message: 'Complaint received. CivicAI is analysing the report.' });
  await processComplaint(complaint);
  await findDuplicate(complaint);
  return complaint;
}

