import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDatabase } from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import complaintRoutes from './routes/complaintRoutes.js';
import directoryRoutes from './routes/directoryRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import { errorHandler, notFound } from './middleware/error.js';
import { startEscalationJob } from './jobs/escalationJob.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.resolve(__dirname, '..', 'uploads')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'civicai-api', timestamp: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api', directoryRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use(notFound);
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 5000);
  connectDatabase().then(() => {
    app.listen(port, () => console.log(`CivicAI API listening on http://localhost:${port}`));
    startEscalationJob();
  }).catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exitCode = 1;
  });
}

