const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const { MongoClient } = require('mongodb');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5000);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'civicresolve';
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

let complaints;
let users;
let signupOtps;
let officialRequests;
const sessions = new Map();
const scrypt = promisify(crypto.scrypt);
const adminEmail = String(process.env.ADMIN_EMAIL || 'hsva1710@gmail.com').trim().toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
const mailTransport = process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use(express.static(__dirname));

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const priorityFor = (urgency) => ({
  high: { label: 'Critical', score: 92 },
  medium: { label: 'High', score: 68 },
  low: { label: 'Medium', score: 42 },
}[urgency] || { label: 'High', score: 68 });

const etaFor = (urgency) => ({
  high: '24–48 hours',
  medium: '3–5 days',
  low: '5–7 days',
}[urgency] || '3–5 days');

const departmentFor = (category) => {
  if (/waste/i.test(category)) return 'Solid Waste Management';
  if (/water|drainage|flood/i.test(category)) return 'Water and Drainage Department';
  if (/streetlight/i.test(category)) return 'Electrical Department';
  if (/public/i.test(category)) return 'Public Facilities Department';
  return 'Public Works Department';
};

const displayTime = (date) => date.toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const makeCaseId = () => `CR-${Math.floor(100000 + Math.random() * 900000)}`;

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, 64);
  return { passwordHash: derivedKey.toString('hex'), passwordSalt: salt };
};

const verifyPassword = async (password, salt, expectedHash) => {
  const derivedKey = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey);
};

const createSession = (user) => {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user._id,
    email: user.email,
    role: user.role,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  });
  return token;
};

const sessionFromRequest = (req) => {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
};

const hashOtp = (email, otp) => crypto.createHash('sha256').update(`${email}:${otp}`).digest('hex');

const sendSignupOtp = async (email, otp) => {
  if (!mailTransport) throw new Error('Email OTP is not configured. Add SMTP_PASS to .env.');
  const sender = process.env.OTP_FROM || process.env.SMTP_USER;
  return mailTransport.sendMail({
    from: `CivicResolve <${sender}>`,
    to: email,
    subject: 'CivicResolve email verification code',
    text: `Your CivicResolve verification code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your CivicResolve verification code is:</p><h2 style="letter-spacing:4px">${otp}</h2><p>This code expires in 10 minutes.</p>`,
  });
};

const databaseRequired = (handler) => async (req, res, next) => {
  if (!complaints) {
    return res.status(503).json({ message: 'MongoDB is not connected. Check MONGODB_URI and start the API again.' });
  }
  return handler(req, res, next);
};

const adminRequired = (handler) => databaseRequired(async (req, res, next) => {
  const session = sessionFromRequest(req);
  if (!session || session.role !== 'admin' || session.email !== adminEmail) {
    return res.status(403).json({ message: 'Admin access is required.' });
  }
  return handler(req, res, next);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: Boolean(complaints), database: databaseName });
});

app.post('/api/auth/signup/request-otp', databaseRequired(async (req, res) => {
  const {
    name = '', email = '', phone = '', password = '', role = 'citizen',
    location = '', coordinates = null,
  } = req.body || {};
  const normalizedEmail = String(email).trim().toLowerCase();

  if (!String(name).trim() || !normalizedEmail || !String(phone).trim() || !password || !String(location).trim()) {
    return res.status(400).json({ message: 'Name, Gmail, phone number, password, and location are required.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({ message: 'Please enter a valid Gmail/email address.' });
  }
  if (!/^\+?[0-9\s-]{7,15}$/.test(String(phone).trim())) {
    return res.status(400).json({ message: 'Please enter a valid phone number.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }
  if (!['citizen', 'official'].includes(role)) {
    return res.status(400).json({ message: 'Please choose a valid account type.' });
  }
  if (await users.findOne({ email: normalizedEmail })) {
    return res.status(409).json({ message: 'An account with this email already exists.' });
  }
  if (role === 'official' && await officialRequests.findOne({ email: normalizedEmail, status: 'pending' })) {
    return res.status(409).json({ message: 'Your government-official request is already waiting for admin approval.' });
  }

  const recentOtp = await signupOtps.findOne({
    email: normalizedEmail,
    createdAt: { $gt: new Date(Date.now() - 60 * 1000) },
  });
  if (recentOtp) {
    return res.status(429).json({ message: 'Please wait one minute before requesting another OTP.' });
  }

  const { passwordHash, passwordSalt } = await hashPassword(String(password));
  const otp = String(crypto.randomInt(100000, 1000000));
  const pendingSignup = {
    email: normalizedEmail,
    name: String(name).trim(),
    phone: String(phone).trim(),
    location: String(location).trim(),
    coordinates: coordinates && Number.isFinite(Number(coordinates.latitude)) && Number.isFinite(Number(coordinates.longitude))
      ? { latitude: Number(coordinates.latitude), longitude: Number(coordinates.longitude) }
      : null,
    role,
    passwordHash,
    passwordSalt,
    otpHash: hashOtp(normalizedEmail, otp),
    attempts: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  };

  await signupOtps.deleteMany({ email: normalizedEmail });
  await signupOtps.insertOne(pendingSignup);
  try {
    const delivery = await sendSignupOtp(normalizedEmail, otp);
    console.log(`Signup OTP accepted for recipient ${normalizedEmail}: ${delivery.accepted?.join(', ') || 'unknown'}`);
  } catch (error) {
    await signupOtps.deleteOne({ email: normalizedEmail });
    console.error('Unable to send signup OTP:', error.message);
    return res.status(503).json({ message: 'Unable to send the verification email. Check SMTP settings in .env.' });
  }

  return res.json({ message: 'Verification OTP sent to your email address.' });
}));

app.post('/api/auth/signup/verify-otp', databaseRequired(async (req, res) => {
  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
  const otp = String(req.body?.otp || '').trim();
  const pendingSignup = await signupOtps.findOne({ email: normalizedEmail });

  if (!pendingSignup || pendingSignup.expiresAt <= new Date()) {
    await signupOtps.deleteOne({ email: normalizedEmail });
    return res.status(400).json({ message: 'OTP expired. Please request a new OTP.' });
  }
  if (pendingSignup.attempts >= 5) {
    await signupOtps.deleteOne({ email: normalizedEmail });
    return res.status(429).json({ message: 'Too many incorrect OTP attempts. Please request a new OTP.' });
  }
  if (!/^\d{6}$/.test(otp) || hashOtp(normalizedEmail, otp) !== pendingSignup.otpHash) {
    await signupOtps.updateOne({ _id: pendingSignup._id }, { $inc: { attempts: 1 } });
    return res.status(401).json({ message: 'Incorrect OTP.' });
  }
  if (await users.findOne({ email: normalizedEmail })) {
    await signupOtps.deleteOne({ _id: pendingSignup._id });
    return res.status(409).json({ message: 'An account with this email already exists.' });
  }

  if (pendingSignup.role === 'official') {
    const request = {
      requestId: crypto.randomUUID(),
      name: pendingSignup.name,
      email: pendingSignup.email,
      phone: pendingSignup.phone,
      location: pendingSignup.location,
      coordinates: pendingSignup.coordinates,
      role: 'official',
      passwordHash: pendingSignup.passwordHash,
      passwordSalt: pendingSignup.passwordSalt,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await officialRequests.insertOne(request);
    await signupOtps.deleteOne({ _id: pendingSignup._id });
    return res.status(201).json({
      message: 'Email verified. Your government-official account is waiting for admin approval.',
      pendingApproval: true,
    });
  }

  const user = {
    name: pendingSignup.name,
    email: pendingSignup.email,
    phone: pendingSignup.phone,
    location: pendingSignup.location,
    coordinates: pendingSignup.coordinates,
    role: pendingSignup.role,
    passwordHash: pendingSignup.passwordHash,
    passwordSalt: pendingSignup.passwordSalt,
    verified: true,
    createdAt: new Date(),
  };
  await users.insertOne(user);
  await signupOtps.deleteOne({ _id: pendingSignup._id });
  return res.status(201).json({
    message: 'Account created successfully.',
    user: { name: user.name, email: user.email, phone: user.phone, location: user.location, coordinates: user.coordinates, role: user.role },
  });
}));

app.post('/api/auth/signin', databaseRequired(async (req, res) => {
  const { identifier = '', type = 'email', password = '', requestedRole = '' } = req.body || {};
  const rawIdentifier = String(identifier).trim();
  const normalizedIdentifier = type === 'mobile'
    ? rawIdentifier.replace(/\D/g, '')
    : rawIdentifier.toLowerCase();
  const normalizedRequestedRole = String(requestedRole).trim();

  if (!normalizedIdentifier || !String(password)) {
    return res.status(400).json({ message: 'Email/mobile number and password are required.' });
  }
  if (normalizedRequestedRole && !['citizen', 'official', 'admin'].includes(normalizedRequestedRole)) {
    return res.status(400).json({ message: 'Please choose a valid account type.' });
  }
  if (normalizedRequestedRole === 'admin' && (type !== 'email' || normalizedIdentifier !== adminEmail)) {
    return res.status(403).json({ message: 'Only the configured administrator can use Admin login.' });
  }

  const identityField = type === 'mobile' ? 'phone' : 'email';
  const identity = { [identityField]: normalizedIdentifier };
  const user = await users.findOne(identity);
  const validPassword = user?.passwordHash && user?.passwordSalt
    ? await verifyPassword(String(password), user.passwordSalt, user.passwordHash)
    : false;

  if (!user || !validPassword) {
    return res.status(401).json({ message: 'Incorrect email/mobile number or password.' });
  }
  if (normalizedRequestedRole && user.role !== normalizedRequestedRole) {
    return res.status(403).json({ message: `This account is not registered as a ${normalizedRequestedRole} account.` });
  }

  await users.updateOne({ _id: user._id }, { $set: { lastSignInAt: new Date() } });
  const token = createSession(user);

  return res.json({
    token,
    user: {
      identifier: normalizedIdentifier,
      type,
      role: user.role,
      name: user.name || '',
      email: user.email && !user.email.endsWith('@local.invalid') ? user.email : '',
      phone: user.phone || '',
      location: user.location || '',
      coordinates: user.coordinates || null,
    },
  });
}));

const safeOfficialRequest = (request) => ({
  requestId: request.requestId,
  name: request.name,
  email: request.email,
  phone: request.phone,
  location: request.location,
  coordinates: request.coordinates || null,
  role: request.role,
  status: request.status,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

app.get('/api/admin/notifications', adminRequired(async (req, res) => {
  const requests = await officialRequests.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
  return res.json({ count: requests.length, requests: requests.map(safeOfficialRequest) });
}));

app.post('/api/admin/official-requests/:requestId/approve', adminRequired(async (req, res) => {
  const request = await officialRequests.findOne({ requestId: req.params.requestId, status: 'pending' });
  if (!request) return res.status(404).json({ message: 'Pending official request not found.' });
  if (await users.findOne({ email: request.email })) {
    await officialRequests.updateOne(
      { _id: request._id },
      { $set: { status: 'rejected', decision: 'duplicate-account', updatedAt: new Date() } },
    );
    return res.status(409).json({ message: 'An account with this email already exists.' });
  }

  const user = {
    name: request.name,
    email: request.email,
    phone: request.phone,
    location: request.location,
    coordinates: request.coordinates || null,
    role: 'official',
    passwordHash: request.passwordHash,
    passwordSalt: request.passwordSalt,
    verified: true,
    approvedBy: adminEmail,
    createdAt: new Date(),
  };
  await users.insertOne(user);
  await officialRequests.updateOne(
    { _id: request._id },
    { $set: { status: 'approved', decision: 'approved', decidedBy: adminEmail, updatedAt: new Date() } },
  );
  return res.json({ message: 'Government official account approved.', request: safeOfficialRequest({ ...request, status: 'approved' }) });
}));

app.post('/api/admin/official-requests/:requestId/reject', adminRequired(async (req, res) => {
  const result = await officialRequests.findOneAndUpdate(
    { requestId: req.params.requestId, status: 'pending' },
    { $set: { status: 'rejected', decision: 'rejected', decidedBy: adminEmail, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ message: 'Pending official request not found.' });
  return res.json({ message: 'Government official request rejected.', request: safeOfficialRequest(result) });
}));

app.post('/api/complaints', databaseRequired(async (req, res) => {
  const {
    category, description, location, urgency = 'medium',
    name = '', phone = '', photoDataUrl = '', reporter = null,
  } = req.body || {};

  if (!category || !description || !location) {
    return res.status(400).json({ message: 'Category, description, and location are required.' });
  }

  if (!['low', 'medium', 'high'].includes(urgency)) {
    return res.status(400).json({ message: 'Urgency must be low, medium, or high.' });
  }

  if (typeof photoDataUrl === 'string' && photoDataUrl.length > 5_000_000) {
    return res.status(413).json({ message: 'The selected photo is too large. Please choose an image under 4 MB.' });
  }

  const createdAt = new Date();
  const priority = priorityFor(urgency);
  const duplicateCount = await complaints.countDocuments({
    category,
    location: { $regex: escapeRegex(location.trim()), $options: 'i' },
  });

  const complaint = {
    id: makeCaseId(),
    category: category.trim(),
    description: description.trim(),
    summary: description.trim(),
    location: location.trim(),
    urgency,
    name: String(name).trim(),
    phone: String(phone).trim(),
    reporter,
    photoDataUrl: typeof photoDataUrl === 'string' ? photoDataUrl : '',
    department: departmentFor(category),
    team: 'Civic response team',
    priority: priority.label,
    impactScore: priority.score,
    duplicates: duplicateCount,
    eta: etaFor(urgency),
    status: 'Received',
    timeline: [{
      time: displayTime(createdAt),
      title: 'Complaint Received',
      desc: 'AI classified and registered the complaint',
      done: true,
    }],
    createdAt,
    updatedAt: createdAt,
  };

  await complaints.insertOne(complaint);
  return res.status(201).json(complaint);
}));

app.get('/api/complaints', databaseRequired(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const records = await complaints.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return res.json(records);
}));

app.get('/api/complaints/:id', databaseRequired(async (req, res) => {
  const complaint = await complaints.findOne({ id: req.params.id.toUpperCase() });
  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
  return res.json(complaint);
}));

app.patch('/api/complaints/:id/status', databaseRequired(async (req, res) => {
  const allowedStatuses = ['Received', 'Assigned', 'In Progress', 'Resolved', 'Escalated'];
  const { status, note = '' } = req.body || {};
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: `Status must be one of: ${allowedStatuses.join(', ')}.` });
  }

  const now = new Date();
  const update = {
    $set: { status, updatedAt: now },
    $push: {
      timeline: {
        time: displayTime(now),
        title: status,
        desc: note || `Complaint status updated to ${status}`,
        done: status === 'Resolved' ? true : status !== 'Received',
      },
    },
  };
  const result = await complaints.findOneAndUpdate(
    { id: req.params.id.toUpperCase() },
    update,
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ message: 'Complaint not found.' });
  return res.json(result);
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function ensureAdminAccount() {
  if (!adminPassword) {
    console.warn('ADMIN_PASSWORD is not configured. Add it to .env before using the admin account.');
    return;
  }
  const existing = await users.findOne({ email: adminEmail });
  if (existing) {
    if (existing.role !== 'admin') {
      console.error(`ADMIN_EMAIL ${adminEmail} already belongs to a non-admin user; admin account was not changed.`);
      return;
    }
    const { passwordHash, passwordSalt } = await hashPassword(adminPassword);
    await users.updateOne(
      { _id: existing._id },
      { $set: { role: 'admin', passwordHash, passwordSalt, verified: true, updatedAt: new Date() } },
    );
    console.log(`Admin account credentials synchronized for ${adminEmail}`);
    return;
  }
  const { passwordHash, passwordSalt } = await hashPassword(adminPassword);
  await users.insertOne({
    name: 'CivicResolve Administrator',
    email: adminEmail,
    phone: '',
    location: 'CivicResolve Administration',
    role: 'admin',
    passwordHash,
    passwordSalt,
    verified: true,
    createdAt: new Date(),
  });
  console.log(`Admin account initialized for ${adminEmail}`);
}

async function start() {
  await client.connect();
  const db = client.db(databaseName);
  complaints = db.collection('complaints');
  users = db.collection('users');
  signupOtps = db.collection('signupOtps');
  officialRequests = db.collection('officialRequests');
  await complaints.createIndex({ id: 1 }, { unique: true });
  await complaints.createIndex({ createdAt: -1 });
  await users.createIndex({ email: 1 }, { unique: true });
  await signupOtps.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await officialRequests.createIndex({ requestId: 1 }, { unique: true });
  await officialRequests.createIndex({ status: 1, createdAt: -1 });
  await ensureAdminAccount();
  app.listen(port, () => console.log(`CivicResolve running at http://localhost:${port}`));
}

start().catch((error) => {
  console.error('Unable to connect to MongoDB:', error.message);
  process.exitCode = 1;
});
