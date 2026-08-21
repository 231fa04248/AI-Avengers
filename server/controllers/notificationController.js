import Notification from '../models/Notification.js';

export async function list(req, res, next) {
  try { res.json({ notifications: await Notification.find({ recipient: req.user._id }).populate('complaint', 'complaintId title').sort('-createdAt').limit(100) }); } catch (error) { next(error); }
}
export async function read(req, res, next) {
  try { res.json({ notification: await Notification.findOneAndUpdate({ _id: req.params.id, recipient: req.user._id }, { readAt: new Date() }, { new: true }) }); } catch (error) { next(error); }
}
export async function readAll(req, res, next) {
  try { await Notification.updateMany({ recipient: req.user._id, readAt: null }, { readAt: new Date() }); res.json({ message: 'Notifications marked as read' }); } catch (error) { next(error); }
}

