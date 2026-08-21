import Department from '../models/Department.js';
import Team from '../models/Team.js';
import User from '../models/User.js';

export async function listDepartments(req, res, next) {
  try { res.json({ departments: await Department.find({ isActive: true }).populate('officer', 'name email').sort('name') }); } catch (error) { next(error); }
}

export async function createDepartment(req, res, next) {
  try { res.status(201).json({ department: await Department.create(req.body) }); } catch (error) { next(error); }
}

export async function updateDepartment(req, res, next) {
  try { res.json({ department: await Department.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }) }); } catch (error) { next(error); }
}

export async function deleteDepartment(req, res, next) {
  try { await Department.findByIdAndUpdate(req.params.id, { isActive: false }); res.json({ message: 'Department archived' }); } catch (error) { next(error); }
}

export async function listTeams(req, res, next) {
  try { res.json({ teams: await Team.find({ isActive: true }).populate('department', 'name code').populate('lead members', 'name email').sort('name') }); } catch (error) { next(error); }
}

export async function createTeam(req, res, next) {
  try { res.status(201).json({ team: await Team.create(req.body) }); } catch (error) { next(error); }
}

export async function updateTeam(req, res, next) {
  try { res.json({ team: await Team.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }) }); } catch (error) { next(error); }
}

export async function deleteTeam(req, res, next) {
  try { await Team.findByIdAndUpdate(req.params.id, { isActive: false }); res.json({ message: 'Team archived' }); } catch (error) { next(error); }
}

export async function listUsers(req, res, next) {
  try { res.json({ users: await User.find({}).populate('department team', 'name').sort('-createdAt') }); } catch (error) { next(error); }
}

export async function updateUser(req, res, next) {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { role: req.body.role, department: req.body.department, team: req.body.team, isActive: req.body.isActive }, { new: true }).populate('department team', 'name');
    res.json({ user });
  } catch (error) { next(error); }
}

