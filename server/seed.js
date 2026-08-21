import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import User from './models/User.js';
import Department from './models/Department.js';
import Team from './models/Team.js';
import Complaint from './models/Complaint.js';
import ComplaintUpdate from './models/ComplaintUpdate.js';
import Notification from './models/Notification.js';
import { getDeadline } from './utils/priority.js';

const departments = [
  ['Roads Department', 'ROADS', '#f97316'], ['Drainage Department', 'DRAIN', '#06b6d4'], ['Waste Management Department', 'WASTE', '#84cc16'],
  ['Water Supply Department', 'WATER', '#3b82f6'], ['Electrical Department', 'ELEC', '#eab308'], ['Public Facilities Department', 'FAC', '#8b5cf6']
];

async function seed() {
  await connectDatabase();
  await Promise.all([User.deleteMany({}), Department.deleteMany({}), Team.deleteMany({}), Complaint.deleteMany({}), ComplaintUpdate.deleteMany({}), Notification.deleteMany({})]);
  const admin = await User.create({ name: 'Aarav Mehta', email: 'admin@civicai.local', password: 'CivicAI@2026', role: 'admin' });
  const citizen = await User.create({ name: 'Priya Sharma', email: 'citizen@civicai.local', password: 'CivicAI@2026', role: 'citizen', ward: 'Ward 12' });
  const createdDepartments = [];
  for (const [name, code, color] of departments) createdDepartments.push(await Department.create({ name, code, color }));
  const officer = await User.create({ name: 'Rohan Kumar', email: 'roads.officer@civicai.local', password: 'CivicAI@2026', role: 'department_officer', department: createdDepartments[0]._id });
  createdDepartments[0].officer = officer._id;
  await createdDepartments[0].save();
  const worker = await User.create({ name: 'Dev Singh', email: 'field.worker@civicai.local', password: 'CivicAI@2026', role: 'field_worker', department: createdDepartments[0]._id });
  const team = await Team.create({ name: 'North Zone Response', department: createdDepartments[0]._id, lead: worker._id, members: [worker._id] });
  worker.team = team._id;
  await worker.save();
  const samples = [
    { complaintId: 'CIV-2026-000001', citizen: citizen._id, title: 'Deep pothole near school gate', description: 'A large pothole has opened on the main road near the school gate. Two-wheelers are swerving into traffic every morning.', category: 'Road Damage', priority: 'Critical', priorityScore: 84, severity: 82, urgency: 84, safetyRisk: 90, impactScore: 76, department: createdDepartments[0]._id, assignedTeam: team._id, assignedWorker: worker._id, status: 'In Progress', location: { address: '12 Lake View Road', latitude: 16.5062, longitude: 80.6480 }, aiSummary: 'Critical road damage near a school with elevated safety risk.', affectedCitizens: 14, deadline: getDeadline('Critical', new Date(Date.now() - 1000 * 60 * 60 * 2)) },
    { complaintId: 'CIV-2026-000002', citizen: citizen._id, title: 'Overflowing waste collection point', description: 'Mixed waste has been accumulating for three days beside the market entrance.', category: 'Waste', priority: 'High', priorityScore: 64, severity: 60, urgency: 70, safetyRisk: 48, impactScore: 68, department: createdDepartments[2]._id, status: 'Assigned', location: { address: 'Central Market Entrance', latitude: 16.5074, longitude: 80.6467 }, aiSummary: 'Waste collection point requires prompt clearance.' },
    { complaintId: 'CIV-2026-000003', citizen: citizen._id, title: 'Streetlight not working', description: 'The streetlight outside the community park has been off for a week.', category: 'Streetlight', priority: 'Medium', priorityScore: 42, severity: 34, urgency: 52, safetyRisk: 44, impactScore: 42, department: createdDepartments[4]._id, status: 'Resolved', location: { address: 'Community Park, 4th Avenue', latitude: 16.5058, longitude: 0.6494 }, aiSummary: 'Public streetlight outage reported near a community park.', resolvedAt: new Date(Date.now() - 1000 * 60 * 60 * 20), deadline: getDeadline('Medium', new Date(Date.now() - 1000 * 60 * 60 * 48)) }
  ];
  const complaints = await Complaint.insertMany(samples);
  await ComplaintUpdate.insertMany(complaints.flatMap((complaint) => [{ complaint: complaint._id, author: citizen._id, type: 'system', status: 'Submitted', message: 'Complaint submitted by citizen.' }, { complaint: complaint._id, author: admin._id, type: 'ai', status: complaint.status, message: complaint.aiSummary } ]));
  await Notification.insertMany([{ recipient: citizen._id, complaint: complaints[0]._id, title: 'Welcome to CivicAI', message: 'Your civic reports are now transparent from submission to resolution.', type: 'success' }, { recipient: officer._id, complaint: complaints[0]._id, title: 'New critical case', message: 'CIV-2026-000001 needs field attention.', type: 'critical' }]);
  console.log('Seed complete. Demo password: CivicAI@2026');
  await disconnectDatabase();
}

seed().catch(async (error) => { console.error(error); await disconnectDatabase(); process.exitCode = 1; });

