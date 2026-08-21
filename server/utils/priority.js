import { DEADLINE_HOURS } from './constants.js';

export function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

export function calculatePriority({ severity = 0, urgency = 0, safetyRisk = 0, impactScore = 0 }) {
  const score = clampScore(
    Number(severity) * 0.3 + Number(urgency) * 0.25 + Number(safetyRisk) * 0.25 + Number(impactScore) * 0.2
  );
  const priority = score >= 75 ? 'Critical' : score >= 50 ? 'High' : score >= 25 ? 'Medium' : 'Low';
  return { score, priority };
}

export function getDeadline(priority, from = new Date()) {
  const deadline = new Date(from);
  deadline.setHours(deadline.getHours() + (DEADLINE_HOURS[priority] || DEADLINE_HOURS.Medium));
  return deadline;
}

export function remainingTime(deadline) {
  const diff = new Date(deadline).getTime() - Date.now();
  if (diff <= 0) return { label: 'Overdue', milliseconds: diff, overdue: true };
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return { label: days ? `${days}d ${remainingHours}h` : `${hours}h`, milliseconds: diff, overdue: false };
}

