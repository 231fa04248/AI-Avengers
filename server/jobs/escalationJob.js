import cron from 'node-cron';
import Complaint from '../models/Complaint.js';
import Escalation from '../models/Escalation.js';
import User from '../models/User.js';
import { createTimeline } from '../services/complaintService.js';
import { notify, notifyMany } from '../services/notificationService.js';

export async function runEscalationSweep() {
  const overdue = await Complaint.find({ deadline: { $lt: new Date() }, status: { $nin: ['Resolved', 'Closed', 'Rejected'] } }).populate('department');
  for (const complaint of overdue) {
    const existing = await Escalation.find({ complaint: complaint._id }).sort('-level').limit(1);
    const currentLevel = existing[0]?.level || 0;
    const nextLevel = Math.min(3, currentLevel + 1);
    if (currentLevel >= 3) continue;
    const target = nextLevel === 1
      ? complaint.department?.officer
      : (await User.findOne({ role: 'admin', isActive: true }).select('_id'))?._id;
    const escalation = await Escalation.create({ complaint: complaint._id, level: nextLevel, reason: `Deadline exceeded for ${complaint.priority.toLowerCase()} priority complaint.`, escalatedTo: target });
    complaint.status = 'Escalated';
    await complaint.save();
    await createTimeline({ complaint: complaint._id, author: target || complaint.citizen, type: 'escalation', status: 'Escalated', message: `Escalation level ${escalation.level} created because the complaint is overdue.` });
    await notify({ recipient: target, complaint: complaint._id, title: `Level ${nextLevel} escalation`, message: `${complaint.complaintId} is overdue and needs attention.`, type: 'critical' });
    await notifyMany([complaint.citizen], { complaint: complaint._id, title: 'Complaint escalation update', message: `${complaint.complaintId} has been escalated for faster attention.`, type: 'warning' });
  }
}

export function startEscalationJob() {
  return cron.schedule('*/15 * * * *', () => runEscalationSweep().catch((error) => console.error('Escalation sweep failed:', error)));
}

