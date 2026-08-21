import Notification from '../models/Notification.js';

export async function notify({ recipient, complaint, title, message, type = 'info' }) {
  if (!recipient) return null;
  return Notification.create({ recipient, complaint, title, message, type });
}

export async function notifyMany(recipients, payload) {
  const ids = [...new Set(recipients.filter(Boolean).map((value) => String(value)))];
  if (!ids.length) return [];
  return Notification.insertMany(ids.map((recipient) => ({ ...payload, recipient })));
}

