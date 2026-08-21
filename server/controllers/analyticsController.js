import Complaint from '../models/Complaint.js';

const count = (field) => Complaint.aggregate([{ $group: { _id: `$${field}`, value: { $sum: 1 } } }, { $sort: { value: -1 } }]);

export async function overview(req, res, next) {
  try {
    const [total, open, critical, resolved, overdue, avg] = await Promise.all([
      Complaint.countDocuments(), Complaint.countDocuments({ status: { $nin: ['Resolved', 'Closed', 'Rejected'] } }), Complaint.countDocuments({ priority: 'Critical', status: { $nin: ['Closed', 'Rejected'] } }), Complaint.countDocuments({ status: { $in: ['Resolved', 'Closed'] } }), Complaint.countDocuments({ deadline: { $lt: new Date() }, status: { $nin: ['Resolved', 'Closed', 'Rejected'] } }), Complaint.aggregate([{ $match: { resolvedAt: { $exists: true }, createdAt: { $exists: true } } }, { $group: { _id: null, value: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } } } }])
    ]);
    res.json({ metrics: { total, open, critical, resolved, overdue, averageResolutionHours: avg[0] ? Math.round(avg[0].value / 3600000) : 0 } });
  } catch (error) { next(error); }
}

export async function byCategory(req, res, next) { try { res.json({ data: await count('category') }); } catch (error) { next(error); } }
export async function byPriority(req, res, next) { try { res.json({ data: await count('priority') }); } catch (error) { next(error); } }
export async function byStatus(req, res, next) { try { res.json({ data: await count('status') }); } catch (error) { next(error); } }
export async function byDepartment(req, res, next) { try { res.json({ data: await Complaint.aggregate([{ $group: { _id: '$department', total: { $sum: 1 }, resolved: { $sum: { $cond: [{ $in: ['$status', ['Resolved', 'Closed']] }, 1, 0] } } } }, { $sort: { total: -1 } }]).then((rows) => Complaint.populate(rows, { path: '_id', select: 'name' })) }); } catch (error) { next(error); } }
export async function recurring(req, res, next) { try { res.json({ data: await Complaint.aggregate([{ $group: { _id: { category: '$category', lat: { $round: ['$location.latitude', 3] }, lng: { $round: ['$location.longitude', 3] } }, reports: { $sum: 1 }, affectedCitizens: { $sum: '$affectedCitizens' } } }, { $match: { reports: { $gte: 2 } } }, { $sort: { reports: -1 } }, { $limit: 20 }]) }); } catch (error) { next(error); } }
export async function locations(req, res, next) { try { res.json({ data: await Complaint.find({}).select('complaintId title category priority status location').sort('-createdAt').limit(500) }); } catch (error) { next(error); } }

