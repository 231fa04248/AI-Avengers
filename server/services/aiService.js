import axios from 'axios';
import { calculatePriority } from '../utils/priority.js';
import { CATEGORY_DEPARTMENTS } from '../utils/constants.js';

const keywordCategories = [
  [['pothole', 'road', 'pavement', 'crater'], 'Road Damage'],
  [['drain', 'sewage', 'flood', 'manhole'], 'Drainage'],
  [['garbage', 'waste', 'trash', 'dump'], 'Waste'],
  [['water', 'leak', 'pipe', 'supply'], 'Water'],
  [['streetlight', 'lamp', 'light', 'dark'], 'Streetlight'],
  [['park', 'toilet', 'bench', 'facility'], 'Public Facility']
];

function localAnalyze({ title = '', description = '', category = 'Other' }) {
  const text = `${title} ${description}`.toLowerCase();
  const match = keywordCategories.find(([words]) => words.some((word) => text.includes(word)));
  const resolvedCategory = category !== 'Other' ? category : match?.[1] || 'Other';
  const danger = /(accident|injur|danger|exposed|collapse|fire|electric|flood)/i.test(text);
  const severity = danger ? 82 : resolvedCategory === 'Road Damage' ? 66 : 52;
  const urgency = /(now|urgent|blocking|daily|immediate)/i.test(text) ? 84 : 56;
  const safetyRisk = danger ? 88 : 38;
  const impactScore = /(school|hospital|main road|many|neighbourhood|residents)/i.test(text) ? 78 : 48;
  const { score, priority } = calculatePriority({ severity, urgency, safetyRisk, impactScore });
  return {
    category: resolvedCategory,
    confidence: match || category !== 'Other' ? 0.9 : 0.62,
    summary: `${resolvedCategory} concern reported: ${description.slice(0, 180)}${description.length > 180 ? 'â€¦' : ''}`,
    severity, urgency, safetyRisk, impactScore, priorityScore: score, priority,
    department: CATEGORY_DEPARTMENTS[resolvedCategory],
    reasoning: danger ? 'Potential safety risk and public impact raised the priority.' : 'Priority reflects the reported condition, urgency language, and likely community impact.'
  };
}

export async function analyzeComplaint(input) {
  const fallback = localAnalyze(input);
  const base = process.env.AI_SERVICE_URL;
  if (!base) return fallback;
  try {
    const { data } = await axios.post(`${base}/analyze`, input, { timeout: 12000 });
    return { ...fallback, ...data };
  } catch (error) {
    console.warn('AI service unavailable; using local analysis fallback:', error.message);
    return fallback;
  }
}

export { localAnalyze };

