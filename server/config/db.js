import mongoose from 'mongoose';

export async function connectDatabase() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/civic_ai';
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log(`MongoDB connected: ${mongoose.connection.name}`);
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

