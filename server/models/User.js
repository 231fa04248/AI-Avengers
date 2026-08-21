import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLES } from '../utils/constants.js';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
  role: { type: String, enum: ROLES, default: 'citizen' },
  phone: String,
  avatar: String,
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  ward: String,
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date
}, { timestamps: true });

userSchema.pre('save', async function save(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(value) {
  return bcrypt.compare(value, this.password);
};

userSchema.methods.toJSON = function toJSON() {
  const data = this.toObject();
  delete data.password;
  delete data.__v;
  return data;
};

export default mongoose.model('User', userSchema);

