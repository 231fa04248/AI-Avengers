import Complaint from '../models/Complaint.js';
import ComplaintUpdate from '../models/ComplaintUpdate.js';
import Department from '../models/Department.js';
import Team from '../models/Team.js';
import User from '../models/User.js';
import DuplicateGroup from '../models/DuplicateGroup.js';
import { createComplaint, createTimeline, findDuplicate, processComplaint } from '../services/complaintService.js';
import { notify, notifyMany } from '../services/notificationService.js';

function canSee(user, complaint) {
  if (user.role === 'admin') return true;
  if (user.role === 'citizen') return String(complaint.citizen?._id || complaint.citizen) === String(user._id);
  if (user.role === 'department_officer') return String(complaint.department?._id || complaint.department) === String(user.department?._id || user.department);
  if (user.role === 'field_worker') return String(complaint.assignedWorker?._id || complaint.assignedWorker) === String(user._id);
  return false;
}

const detailPopulate = [
  { path: 'citizen', select: 'name email phone' },
  { path: 'department', select: 'name code color' },
  { path: 'assignedTeam', select: 'name' },
  { path: 'assignedWorker', select: 'name email' },
  { path: 'duplicateOf', select: 'complaintId title status' },
  { path: 'duplicateGroup', select: 'complaints affectedCitizens override' }
];

export async function create(req, res, next) {
  try {
    if (!req.body.location) return res.status(400).json({ message: 'A complaint location is required' });
    const complaint = await createComplaint({ data: req.body, citizen: req.user, files: req.files });
    res.status(201).json({ complaint: await Complaint.findById(complaint._id).populate(detailPopulate) });
  } catch (error) { next(error); }
}

export async function list(req, res, next) {
  try {
    const query = {};
    if (req.user.role === 'citizen') query.citizen = req.user._id;
    if (req.user.role === 'department_officer') query.department = req.user.department?._id || req.user.department;
    if (req.user.role === 'field_worker') query.assignedWorker = req.user._id;
    if (req.query.status) query.status = req.query.status;
    if (req.query.priority) query.priority = req.query.priority;
    if (req.query.category) query.category = req.query.category;
    if (req.query.search) query.$or = [{ complaintId: new RegExp(req.query.search, 'i') }, { title: new RegExp(req.query.search, 'i') }];
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const [complaints, total] = await Promise.all([
      Complaint.find(query).populate(detailPopulate).sort('-createdAt').skip((page - 1) * limit).limit(limit),
      Complaint.countDocuments(query)
    ]);
    res.json({ complaints, total, page, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
}

export async function getOne(req, res, next) {
  try {
    const complaint = await Complaint.findById(req.params.id).populate(detailPopulate);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found' });
    if (!canSee(req.user, complaint)) return res.status(403).json({ message: 'You cannot view this complaint' });
    res.json({ complaint });
  } catch (error) { next(error); }
}

export async function update(req, res, next) {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint || !canSee(req.user, complaint)) return res.status(404).json({ message: 'Complaint not found' });
    if (!['admin', 'department_officer'].includes(req.user.role) && String(complaint.citizen) !== String(req.user._id)) return res.status(403).json({ message: 'You cannot edit this complaint' });
    const allowed = ['title', 'description', 'location', 'category'];
    for (const field of allowed) if (req.body[field] !== undefined) complaint[field] = typeof req.body[field] === 'string' && field === 'location' ? JSON.parse(req.body[field]) : req.body[field];
    await complaint.save();
    res.json({ complaint: await Complaint.findById(complaint._id).populate(detailPopulate) });
  } catch (error) { next(error); }
}

export async function remove(req, res, next) {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint || !canSee(req.user, complaint)) return res.status(404).json({ message: 'Complaint not found' });
    if (!['citizen', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'You cannot remove this complaint' });
    await complaint.deleteOne();
    res.json({ message: 'Complaint removed' });
  } catch (error) { next(error); }
}

export async function assign(req, res, next) {
  try {
    if (!['admin', 'department_officer'].includes(req.user.role)) return res.status(403).json({ message: 'Only operations staff can assign complaints' });
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found' });
    const { teamId, workerId } = req.body;
    if (teamId) complaint.assignedTeam = (await Team.findById(teamId))?._id;
    if (workerId) complaint.assignedWorker = (await User.findOne({ _id: workerId, role: 'field_worker' }))?._id;
    complaint.status = 'Assigned';
    await complaint.save();
    await createTimeline({ complaint: complaint._id, author: req.user._id, type: 'assignment', status: 'Assigned', message: 'Complaint assignment updated by operations staff.' });
    await notifyMany([complaint.assignedWorker, complaint.citizen], { complaint: complaint._id, title: 'Complaint assignment updated', message: `${complaint.complaintId} has a new field assignment.`, type: 'info' });
    res.json({ complaint: await Complaint.findById(complaint._id).populate(detailPopulate) });
  } catch (error) { next(error); }
}

export async function changeStatus(req, res, next) {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint || !canSee(req.user, complaint)) return res.status(404).json({ message: 'Complaint not found' });
    const { status, message } = req.body;
    const allowed = ['admin', 'department_officer', 'field_worker', 'citizen'].includes(req.user.role);
    if (!allowed || !status) return res.status(400).json({ message: 'A valid status is required' });
    complaint.status = status;
    if (status === 'Resolved') complaint.resolvedAt = new Date();
    if (status === 'Closed') complaint.closedAt = new Date();
    await complaint.save();
    await createTimeline({ complaint: complaint._id, author: req.user._id, type: 'status', status, message: message || `Complaint marked ${status}.` });
    await notify({ recipient: complaint.citizen, complaint: complaint._id, title: `Complaint ${status.toLowerCase()}`, message: `${complaint.complaintId} is now ${status}.`, type: status === 'Resolved' ? 'success' : 'info' });
    res.json({ complaint: await Complaint.findById(complaint._id).populate(detailPopulate) });
  } catch (error) { next(error); }
}

export async function resolve(req, res, next) {
  req.body.status = 'Resolved';
  req.body.message = req.body.notes || 'Field work has been marked resolved.';
  return changeStatus(req, res, next);
}

export async function close(req, res, next) {
  req.body.status = 'Closed';
  req.body.message = req.body.message || 'Complaint closed after resolution confirmation.';
  return changeStatus(req, res, next);
}

export async function reopen(req, res, next) {
  req.body.status = 'In Progress';
  req.body.message = req.body.message || 'Citizen reopened this complaint for further attention.';
  return changeStatus(req, res, next);
}

export async function timeline(req, res, next) {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint || !canSee(req.user, complaint)) return res.status(404).json({ message: 'Complaint not found' });
    res.json({ updates: await ComplaintUpdate.find({ complaint: complaint._id }).populate('author', 'name role').sort('createdAt') });
  } catch (error) { next(error); }
}

export async function addUpdate(req, res, next) {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint || !canSee(req.user, complaint)) return res.status(404).json({ message: 'Complaint not found' });
    const update = await createTimeline({ complaint: complaint._id, author: req.user._id, type: 'note', message: req.body.message || 'Progress update added.', images: (req.files || []).map((file) => ({ url: `/uploads/${file.filename}`, originalName: file.originalname })) });
    res.status(201).json({ update });
  } catch (error) { next(error); }
}

export async function overrideDuplicate(req, res, next) {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Only admins can override duplicate detection' });
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) return res.status(404).json({ message: 'Complaint not found' });
    complaint.duplicateOf = undefined;
    complaint.duplicateScore = undefined;
    complaint.duplicateGroup = undefined;
    await complaint.save();
    await DuplicateGroup.updateMany({ complaints: complaint._id }, { $pull: { complaints: complaint._id }, $set: { override: true, overrideReason: req.body.reason || 'Admin override' } });
    await createTimeline({ complaint: complaint._id, author: req.user._id, type: 'system', message: 'Admin overrode the duplicate detection result.' });
    res.json({ complaint });
  } catch (error) { next(error); }
}

