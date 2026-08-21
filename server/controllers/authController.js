import jwt from 'jsonwebtoken';
import User from '../models/User.js';

function sign(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'change_me', { expiresIn: '7d' });
}

export async function register(req, res, next) {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required' });
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'An account with that email already exists' });
    const user = await User.create({ name, email, password, phone, role: 'citizen' });
    res.status(201).json({ token: sign(user), user: user.toJSON() });
  } catch (error) { next(error); }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: String(email || '').toLowerCase() }).select('+password').populate('department team');
    if (!user || !(await user.comparePassword(password || ''))) return res.status(401).json({ message: 'Email or password is incorrect' });
    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: sign(user), user: user.toJSON() });
  } catch (error) { next(error); }
}

export async function profile(req, res) { res.json({ user: req.user.toJSON() }); }

export async function updateProfile(req, res, next) {
  try {
    const allowed = ['name', 'phone', 'ward', 'avatar'];
    for (const key of allowed) if (req.body[key] !== undefined) req.user[key] = req.body[key];
    await req.user.save();
    res.json({ user: req.user.toJSON() });
  } catch (error) { next(error); }
}

