const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const { MongoClient } = require('mongodb');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const port = Number(process.env.PORT || 5000);
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'civicresolve';
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

let complaints;
let users;
let signupOtps;
let passwordResets;
let officialRequests;
let notifications;
const sessions = new Map();
const scrypt = promisify(crypto.scrypt);
const adminEmail = String(process.env.ADMIN_EMAIL || 'hsva1710@gmail.com').trim().toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
const frontendDirectory = path.join(__dirname, '..', 'frontend');
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
app.use(express.static(frontendDirectory, {
  etag: false,
  maxAge: 0,
  setHeaders: (response, filePath) => {
    if (path.basename(filePath) === 'index.html') response.setHeader('Cache-Control', 'no-store');
  },
}));

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

const agentProfiles = [
  {
    category: 'Roads & Potholes',
    patterns: /road|pothole|street surface|footpath|pavement|traffic/i,
    department: 'Public Works Department',
    team: 'Road Maintenance Unit',
    actions: ['Verify the location with a field photo', 'Place a temporary safety marker', 'Schedule patching or resurfacing'],
  },
  {
    category: 'Drainage & Flooding',
    patterns: /drain|flood|waterlogging|sewage|overflow|open manhole/i,
    department: 'Water and Drainage Department',
    team: 'Stormwater Response Unit',
    actions: ['Inspect the nearest drain or manhole', 'Clear the blockage and make the area safe', 'Check whether nearby reports are part of the same incident'],
  },
  {
    category: 'Waste Management',
    patterns: /waste|garbage|trash|litter|dump|collection|sanitation/i,
    department: 'Solid Waste Management',
    team: 'Sanitation Response Unit',
    actions: ['Verify the missed collection point', 'Dispatch a collection vehicle', 'Record the route for repeat-miss prevention'],
  },
  {
    category: 'Water Supply',
    patterns: /water supply|no water|tap|pipeline|pipe leak|drinking water/i,
    department: 'Water and Drainage Department',
    team: 'Water Supply Response Unit',
    actions: ['Check the local supply line', 'Test for a leak or pressure issue', 'Share the restoration estimate with residents'],
  },
  {
    category: 'Streetlights',
    patterns: /streetlight|street light|lamp|lighting|dark road|darkness/i,
    department: 'Electrical Department',
    team: 'Public Lighting Unit',
    actions: ['Verify the failed fixture after dusk', 'Inspect the power connection', 'Replace or repair the fixture'],
  },
  {
    category: 'Public Facilities',
    patterns: /park|toilet|public facility|playground|bus shelter|bench/i,
    department: 'Public Facilities Department',
    team: 'Public Facilities Unit',
    actions: ['Inspect the facility', 'Create a maintenance work order', 'Confirm the repair with a completion photo'],
  },
];

const officialDepartmentOptions = [...new Set(agentProfiles.map((profile) => profile.department))];

const highRiskSignals = [
  { pattern: /school|hospital|clinic|market|bus stop|railway|children/i, label: 'high-footfall location' },
  { pattern: /accident|injury|danger|unsafe|hazard|risk|blocked road/i, label: 'reported safety risk' },
  { pattern: /flood|waterlogging|sewage|overflow|open manhole|fire/i, label: 'active public-health or access risk' },
  { pattern: /days?|weeks?|months?|again|repeat|still|missed twice/i, label: 'persistent or repeated issue' },
];

const findAgentProfile = (category, description) => {
  const selectedCategory = String(category || '');
  const reportText = String(description || '');
  const selectedProfile = agentProfiles.find((profile) => profile.patterns.test(selectedCategory));
  return selectedProfile || agentProfiles.find((profile) => profile.patterns.test(reportText)) || {
    category: String(category || 'Other').trim() || 'Other',
    department: departmentFor(category || ''),
    team: 'Civic response team',
    actions: ['Verify the report with a field inspection', 'Create the appropriate work order', 'Update the citizen after verification'],
  };
};

const followUpHoursFor = (urgency) => ({ high: 24, medium: 72, low: 120 }[urgency] || 72);

const summarizeReport = (category, description, location) => {
  const cleanDescription = String(description || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  const reportEvidence = cleanDescription || 'Photo evidence submitted for visual complaint triage';
  const clipped = reportEvidence.length > 150 ? `${reportEvidence.slice(0, 147).trim()}...` : reportEvidence;
  return `${category} issue at ${location}: ${clipped}`;
};

const countWords = (value) => String(value || '').trim().split(/\s+/).filter(Boolean).length;

const limitWords = (value, maximum = 2000) => String(value || '').trim().split(/\s+/).filter(Boolean).slice(0, maximum).join(' ');

const buildAgentGeneratedDescription = ({
  category, department, team, location, priority, urgency, impactScore, duplicateCount,
  eta, photoProvided, coordinates, riskFlags = [], recommendedActions = [], visualObservation = '',
}) => {
  const gpsText = coordinates
    ? `GPS coordinates recorded for this report: latitude ${coordinates.latitude}, longitude ${coordinates.longitude}.`
    : 'No GPS coordinates were submitted with this report; the citizen-provided location text is the routing reference.';
  const evidenceText = visualObservation
    ? `The vision layer observed the following in the submitted image: ${visualObservation}`
    : photoProvided
      ? 'A citizen photo is attached as the primary evidence. The image is retained for government verification. Without a vision-capable model, the policy layer does not invent visual details that cannot be confirmed safely.'
      : 'No image evidence was attached; field verification is required.';
  const riskText = riskFlags.length ? riskFlags.join('; ') : 'No additional high-risk signal was detected from the supplied case context.';
  const actionText = recommendedActions.length ? recommendedActions.join('; ') : 'Verify the location, inspect the evidence and record the first field action.';
  return [
    'AGENT-GENERATED CIVIC COMPLAINT DESCRIPTION',
    `This case concerns a ${category} issue reported at ${location}. The Response Agent converted the citizen submission into a structured case for the ${department}, specifically the ${team}. The case is currently assessed as ${priority} priority with ${urgency} urgency, an impact score of ${impactScore}/100, and an expected first response or resolution window of ${eta}.`,
    `Location and evidence: ${location} is the citizen-provided place of concern. ${gpsText} ${evidenceText} The location should be checked against the visible surroundings during field inspection. Officials should verify that the photo belongs to this location, that it is recent enough to represent the current condition, and that no unrelated person or private information is unnecessarily exposed in the evidence.`,
    `Classification and routing: The agent classified the report as ${category}. It routed the case to the ${department} and the ${team} because that team is responsible for the first inspection and corrective action for this type of public-service issue. The classification is an operational recommendation based on the available report signals. If the official finds a different underlying cause, the department, team, work order and explanation should be corrected in the case record.`,
    `Impact and urgency assessment: The case has been given an impact score of ${impactScore}/100. This score helps the operations team order work; it is not a substitute for professional field judgment. The current urgency is ${urgency}. ${riskText} If the issue creates an immediate danger to people, blocks emergency access, affects a school, hospital or other vulnerable site, or is spreading rapidly, the official should raise the status and request supervisor visibility.`,
    `Duplicate and history assessment: The investigation layer found ${duplicateCount} nearby or matching case${duplicateCount === 1 ? '' : 's'} using the available location and category records. If a matching case is confirmed, the official should link the cases so that repeated reports are counted together while preserving each citizen’s evidence and notification history. A repeated issue may require a permanent maintenance intervention rather than repeated temporary work.`,
    `Recommended field plan: ${actionText}. First, confirm the exact site and compare the citizen photo with the current condition. Second, identify the immediate safety or service impact and apply a temporary safeguard when necessary. Third, record the responsible team, materials, contractor or crew and expected milestone in the work order. Fourth, upload a progress photo from a comparable angle and add a plain-language note describing what changed. Finally, upload completion evidence and mark the case resolved only after the official verifies the result.`,
    `Verification and resolution standard: A progress update should state what was inspected, what work was completed, what remains, and when the next update is expected. A completion update should contain a clear resolution note and an after-work image whenever practical. The agent may estimate progress from status, tasks, notes and an enabled vision analysis, but the government official remains responsible for confirming the physical result. A case must not be closed only because a photo was uploaded or because the predicted category was confident.`,
    `Citizen communication: The citizen should be told that the report was received, which department owns it, the current status, the expected response window and any reason for delay or escalation. When the official marks the case resolved, the Resolution and Analytics Agent prepares a concise explanation from the official note and evidence. The citizen can then review the case timeline, progress percentage, official photos and final explanation in the CivicResolve account.`,
    `Audit note: This description was generated by the CivicResolve Response Agent from the citizen-provided location, the submitted image signal, case rules and available complaint history. It is intended to support transparent government action. The official must correct any incorrect classification, location interpretation, duplicate link or progress estimate before final resolution.`,
  ].join('\n\n');
};

const buildOfficialBrief = ({ category, department, team, location, priority, urgency, impactScore, duplicateCount, eta, photoProvided, coordinates, visualObservation = '' }) => {
  const evidence = visualObservation || (photoProvided ? 'Citizen photo attached; verify the visible condition on site.' : 'No photo attached; field evidence is required.');
  const coordinateText = coordinates ? `GPS available (${coordinates.latitude}, ${coordinates.longitude}).` : 'Citizen-provided location text only; confirm the exact site.';
  return `${category} case at ${location}. Route: ${department} / ${team}. Priority: ${priority}; urgency: ${urgency}; impact: ${impactScore}/100; expected response: ${eta}. ${evidence} ${coordinateText} Similar cases found: ${duplicateCount}. Inspect the site, record the first action, upload a comparable progress photo and explain any remaining work. Mark resolved only after physical verification and completion evidence.`;
};

const citizenAgentDefinitions = [
  {
    id: 'citizen-assistance-agent',
    name: 'Citizen Assistance Agent',
    side: 'citizen',
    responsibility: 'Help citizens understand the process and prepare a clear report',
  },
  {
    id: 'complaint-guidance-agent',
    name: 'Complaint Guidance Agent',
    side: 'citizen',
    responsibility: 'Suggest useful evidence, location context and safe next steps',
  },
  {
    id: 'citizen-status-agent',
    name: 'Citizen Status Agent',
    side: 'citizen',
    responsibility: 'Explain case status, progress, ownership, ETA and escalation',
  },
];

const governmentAgentDefinitions = [
  {
    id: 'civic-intelligence-agent',
    name: 'Civic Intelligence Agent',
    side: 'government',
    responsibility: 'Classify, summarize and interpret text, image and GPS signals',
  },
  {
    id: 'decision-agent',
    name: 'Decision Agent',
    side: 'government',
    responsibility: 'Calculate impact, urgency, priority, SLA and escalation rules',
  },
  {
    id: 'investigation-agent',
    name: 'Investigation Agent',
    side: 'government',
    responsibility: 'Find duplicate cases and recurring location-level problems',
  },
  {
    id: 'government-operations-agent',
    name: 'Government Operations Agent',
    side: 'government',
    responsibility: 'Route departments, match nearby officials and manage work orders',
  },
  {
    id: 'resolution-analytics-agent',
    name: 'Resolution & Analytics Agent',
    side: 'government',
    responsibility: 'Verify progress, explain resolutions and produce city insights',
  },
];

const buildAgentNetwork = (activeAgentId = '') => ({
  architecture: 'multi-agent-civic-resolution',
  orchestrator: {
    id: 'civicresolve-orchestrator',
    name: 'CivicResolve Agent Orchestrator',
    responsibility: 'Coordinate citizen and government agents from intake to resolution',
    status: 'completed',
  },
  citizenAgents: citizenAgentDefinitions.map((agent) => ({
    ...agent,
    status: agent.id === activeAgentId ? 'active' : 'available',
  })),
  governmentAgents: governmentAgentDefinitions.map((agent) => ({
    ...agent,
    status: agent.id === activeAgentId ? 'active' : 'available',
  })),
  specialistCount: citizenAgentDefinitions.length + governmentAgentDefinitions.length,
  totalAgents: citizenAgentDefinitions.length + governmentAgentDefinitions.length + 1,
});

const buildResponseAgent = ({ category, description, location, urgency = 'medium', photoDataUrl = '', coordinates = null, createdAt = new Date() }, duplicateCount = 0) => {
  const cleanDescription = String(description || '').trim();
  const cleanLocation = String(location || '').trim();
  const profile = findAgentProfile(category, cleanDescription);
  const requestedUrgency = ['low', 'medium', 'high'].includes(urgency) ? urgency : 'medium';
  const riskFlags = highRiskSignals.filter((signal) => signal.pattern.test(`${cleanDescription} ${cleanLocation}`)).map((signal) => signal.label);
  const urgencyRaised = riskFlags.length > 0 || duplicateCount >= 3;
  const resolvedUrgency = requestedUrgency === 'high' || (requestedUrgency === 'low' && urgencyRaised)
    ? 'high'
    : requestedUrgency === 'medium' && urgencyRaised ? 'high' : requestedUrgency;
  const priority = priorityFor(resolvedUrgency);
  const impactScore = Math.min(99, priority.score + Math.min(duplicateCount * 2, 6) + (riskFlags.length > 1 ? 3 : 0));
  const confidence = Math.min(0.97, 0.76 + (profile.category !== 'Other' ? 0.12 : 0) + (cleanLocation ? 0.04 : 0) + (riskFlags.length ? 0.04 : 0));
  const requiresSupervisorReview = resolvedUrgency === 'high' || profile.category === 'Other' || confidence < 0.86;
  const agentGoal = 'Turn a citizen report into the safest, fastest and most transparent resolution path.';
  const executionPlan = [
    { step: 1, tool: 'citizen.assistance.prepare_report', status: 'completed', output: 'Citizen Assistance Agent prepared the intake path.' },
    { step: 2, tool: 'citizen.guidance.capture_context', status: 'completed', output: coordinates ? 'Complaint Guidance Agent received GPS context and photo evidence.' : 'Complaint Guidance Agent marked location context for verification.' },
    { step: 3, tool: 'intelligence.classify_and_summarize', status: 'completed', output: `${profile.category} classified and summary prepared.` },
    { step: 4, tool: 'investigation.search_similar_cases', status: 'completed', output: `${duplicateCount} nearby case${duplicateCount === 1 ? '' : 's'} found.` },
    { step: 5, tool: 'decision.score_impact_and_urgency', status: 'completed', output: `${priority.label} priority, ${impactScore}/100 impact.` },
    { step: 6, tool: 'operations.select_department_and_official', status: 'completed', output: `${profile.department} / ${profile.team}; GPS official matching enabled.` },
    { step: 7, tool: 'follow_up.schedule_and_monitor', status: 'completed', output: `Follow-up scheduled within ${followUpHoursFor(resolvedUrgency)} hours.` },
    { step: 8, tool: 'resolution.prepare_explanation', status: 'completed', output: requiresSupervisorReview ? 'Supervisor review requested before autonomous progression.' : 'Citizen and official explanations prepared.' },
    { step: 9, tool: 'operations.dispatch_to_official_queue', status: 'completed', output: `Case queued for ${profile.department} / ${profile.team}.` },
  ];
  const escalation = resolvedUrgency === 'high' || duplicateCount >= 3
    ? 'Flag for priority response and supervisor visibility.'
    : 'Keep in the normal response queue and monitor for delay.';
  const reportSummary = summarizeReport(profile.category, cleanDescription, cleanLocation);
  const photoProvided = Boolean(String(photoDataUrl || '').trim());
  const normalizedCoordinates = normalizeCoordinates(coordinates);
  const coordinatesProvided = Boolean(normalizedCoordinates);
  const followUpHours = followUpHoursFor(resolvedUrgency);
  const nextCheckAt = new Date(new Date(createdAt).getTime() + followUpHours * 60 * 60 * 1000);
  const detailedDescription = buildAgentGeneratedDescription({
    category: profile.category,
    department: profile.department,
    team: profile.team,
    location: cleanLocation,
    priority: priority.label,
    urgency: resolvedUrgency,
    impactScore,
    duplicateCount,
    eta: etaFor(resolvedUrgency),
    photoProvided,
    coordinates: normalizedCoordinates,
    riskFlags,
    recommendedActions: profile.actions,
  });
  const officialBrief = buildOfficialBrief({
    category: profile.category,
    department: profile.department,
    team: profile.team,
    location: cleanLocation,
    priority: priority.label,
    urgency: resolvedUrgency,
    impactScore,
    duplicateCount,
    eta: etaFor(resolvedUrgency),
    photoProvided,
    coordinates: normalizedCoordinates,
  });
  const inputSignals = [
    'text description analyzed',
    'location captured for field routing',
    photoProvided ? 'photo attached for official visual verification' : 'no photo attached',
    coordinatesProvided ? 'GPS coordinates available' : 'GPS coordinates unavailable',
  ];
  const nextAction = duplicateCount > 0
    ? `Link this report with ${duplicateCount} nearby case${duplicateCount === 1 ? '' : 's'} and dispatch the ${profile.team}.`
    : `Route to the ${profile.team} for verification and first action.`;
  const trace = [
    {
      id: 'understand',
      title: 'Understand the report',
      detail: `${reportSummary} Classification and summary generated from the text report.`,
      status: 'completed',
    },
    {
      id: 'memory',
      title: 'Check nearby case memory',
      detail: duplicateCount ? `${duplicateCount} similar case${duplicateCount === 1 ? '' : 's'} found at this location.` : 'No similar case found at this location.',
      status: 'completed',
    },
    {
      id: 'decide',
      title: 'Decide priority and owner',
      detail: `${priority.label} priority (${impactScore}/100) routed to ${profile.department}.`,
      status: 'completed',
    },
    {
      id: 'act',
      title: 'Prepare the response plan',
      detail: `${nextAction} Follow-up check scheduled within ${followUpHours} hours.`,
      status: 'completed',
    },
  ];
  const subAgents = [
    { id: 'intake-agent', name: 'Intake Agent', responsibility: 'Classify and summarize the citizen report', result: `${profile.category} identified from the submitted text and category.`, status: 'completed' },
    { id: 'memory-agent', name: 'Memory Agent', responsibility: 'Find similar complaints in MongoDB', result: duplicateCount ? `${duplicateCount} nearby case${duplicateCount === 1 ? '' : 's'} linked.` : 'No nearby duplicate found.', status: 'completed' },
    { id: 'routing-agent', name: 'Routing Agent', responsibility: 'Select the department and response team', result: `${profile.department} → ${profile.team}`, status: 'completed' },
    { id: 'priority-agent', name: 'Priority Agent', responsibility: 'Score risk, impact and urgency', result: `${priority.label} priority with impact score ${impactScore}/100.`, status: 'completed' },
    { id: 'follow-up-agent', name: 'Follow-up Agent', responsibility: 'Schedule monitoring and escalation', result: `Next check within ${followUpHours} hours.`, status: 'completed' },
    { id: 'explanation-agent', name: 'Explanation Agent', responsibility: 'Explain the decision to citizens and officials', result: 'Citizen message and official handoff prepared.', status: 'completed' },
  ];

  return {
    decision: {
      category: profile.category,
      department: profile.department,
      team: profile.team,
      urgency: resolvedUrgency,
      priority: priority.label,
      impactScore,
      eta: etaFor(resolvedUrgency),
       summary: reportSummary,
       detailedDescription,
       officialBrief,
       descriptionWordCount: countWords(detailedDescription),
       duplicateCount,
      riskFlags,
      inputSignals,
      locationEvidence: { text: cleanLocation, coordinates: normalizedCoordinates },
      imageEvidence: { provided: photoProvided, requiresOfficialVerification: photoProvided },
      officialHandoff: { status: 'queued', recipient: 'Government Official Queue', department: profile.department, team: profile.team },
      requiresSupervisorReview,
      escalation,
      nextAction,
      recommendedActions: profile.actions,
      followUp: { nextCheckAt, thresholdHours: followUpHours, escalationRule: escalation },
      confidence,
    },
    agent: {
      name: 'CivicResolve Response Agent',
      role: 'orchestrator',
      architecture: 'coordinator-with-specialists',
      goal: agentGoal,
      executionPlan,
      toolsUsed: [...new Set(executionPlan.map(item => item.tool))],
      decisionMode: requiresSupervisorReview ? 'human-approval-required' : 'recommendation-ready',
      version: '1.0.0',
      provider: process.env.AGENT_PROVIDER || 'local-policy-agent',
      runId: `agent-${crypto.randomBytes(6).toString('hex')}`,
      status: 'completed',
      confidence,
       summary: reportSummary,
       generatedDescription: detailedDescription,
       officialBrief,
       descriptionWordCount: countWords(detailedDescription),
       citizenMessage: `Your report has been routed to ${profile.department}. Expected first response: ${etaFor(resolvedUrgency)}.`,
       capabilities: ['classify', 'summarize', 'find duplicates', 'route', 'prioritize', 'follow up', 'explain', 'dispatch official handoff'],
      inputs: inputSignals,
      subAgents,
      trace,
      followUp: { status: 'scheduled', nextCheckAt, thresholdHours: followUpHours, owner: profile.department },
      safeguards: ['Human official approval is required before a case is marked resolved.', 'High-risk or low-confidence reports stay visible for supervisor review.'],
      completedAt: new Date(),
    },
  };
};

const localModelEnabled = () => ['1', 'true', 'yes'].includes(String(process.env.AGENT_LLM_ENABLED || '').trim().toLowerCase());

const enrichResponseAgent = async ({ category, description, location, photoDataUrl = '' }, agentRun) => {
  if (!localModelEnabled()) return agentRun;
  const modelUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
  const model = process.env.OLLAMA_MODEL || 'gemma3:4b';
  const imageBase64 = String(photoDataUrl || '').replace(/^data:[^;]+;base64,/, '');
  const prompt = `You are the visual and language reasoning layer for a civic complaint response coordinator.\nReturn ONLY valid JSON with these keys: category, summary, citizenMessage, recommendedActions, riskExplanation, visualObservation, detailedDescription, officialBrief.\nIf a photo is attached and the category is Other or blank, inspect the photo and select exactly one category from: Roads & Potholes, Drainage & Flooding, Waste Management, Water Supply, Streetlights, Public Facilities, Other. Never invent a category. If the photo is unclear, use Other. Do not change priority or urgency. Write visualObservation only for details visibly supported by the photo. Write detailedDescription as a structured case description of no more than 2,000 words, including the exact citizen-provided location, classification, evidence, impact, routing, recommended field verification and resolution criteria. Clearly label uncertain details as requiring official verification. Write officialBrief as a concise 100-180 word explanation for a government official. Be factual and do not promise that work is complete.\nCategory supplied by citizen: ${category || 'None'}\nLocation: ${location}\nDescription: ${description || 'No text description; classify the attached photo.'}\nCurrent routing: ${agentRun.decision.department} / ${agentRun.decision.team}\nCurrent priority: ${agentRun.decision.priority} (${agentRun.decision.impactScore}/100)`;

  try {
    const response = await fetch(modelUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt, ...(imageBase64 ? { images: [imageBase64] } : {}) }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Local model returned HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload.message?.content || payload.response || '';
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    const actions = Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.map(item => String(item).trim()).filter(Boolean).slice(0, 5) : [];
    if (!String(parsed.summary || '').trim() || !String(parsed.citizenMessage || '').trim()) throw new Error('Local model response did not include the required explanation fields.');
    const modelObservation = String(parsed.visualObservation || parsed.imageAnalysis || '').trim().slice(0, 1200);
    const visualProfile = findAgentProfile(parsed.category, '');
    const visualClassificationApplied = Boolean(imageBase64 && agentRun.decision.category === 'Other' && visualProfile.category !== 'Other');
    const decisionProfile = visualClassificationApplied ? visualProfile : null;
    const nextAction = agentRun.decision.duplicateCount > 0
      ? `Link this report with ${agentRun.decision.duplicateCount} nearby case${agentRun.decision.duplicateCount === 1 ? '' : 's'} and dispatch the ${(decisionProfile || findAgentProfile(agentRun.decision.category, '')).team}.`
      : `Route to the ${(decisionProfile || findAgentProfile(agentRun.decision.category, '')).team} for verification and first action.`;
    const decision = {
      ...agentRun.decision,
      ...(decisionProfile ? {
        category: decisionProfile.category,
        department: decisionProfile.department,
        team: decisionProfile.team,
        recommendedActions: actions.length ? actions : decisionProfile.actions,
        nextAction,
        imageEvidence: { ...agentRun.decision.imageEvidence, classification: 'vision-classified' },
      } : { imageEvidence: { ...agentRun.decision.imageEvidence, classification: imageBase64 ? 'vision-reviewed' : 'text-reviewed' } }),
      summary: String(parsed.summary).trim().slice(0, 500),
      recommendedActions: decisionProfile ? (actions.length ? actions : decisionProfile.actions) : (actions.length ? actions : agentRun.decision.recommendedActions),
      riskExplanation: String(parsed.riskExplanation || '').trim().slice(0, 500),
    };
    const fallbackDescription = buildAgentGeneratedDescription({
      category: decision.category,
      department: decision.department,
      team: decision.team,
      location,
      priority: decision.priority,
      urgency: decision.urgency,
      impactScore: decision.impactScore,
      duplicateCount: decision.duplicateCount,
      eta: decision.eta,
      photoProvided: Boolean(imageBase64),
      coordinates: decision.locationEvidence?.coordinates,
      riskFlags: decision.riskFlags,
      recommendedActions: decision.recommendedActions,
      visualObservation: modelObservation,
    });
    const detailedDescription = limitWords(String(parsed.detailedDescription || '').trim() || fallbackDescription, 2000);
    const officialBrief = String(parsed.officialBrief || '').trim() || buildOfficialBrief({
      category: decision.category,
      department: decision.department,
      team: decision.team,
      location,
      priority: decision.priority,
      urgency: decision.urgency,
      impactScore: decision.impactScore,
      duplicateCount: decision.duplicateCount,
      eta: decision.eta,
      photoProvided: Boolean(imageBase64),
      coordinates: decision.locationEvidence?.coordinates,
      visualObservation: modelObservation,
    });
    decision.detailedDescription = detailedDescription;
    decision.officialBrief = officialBrief;
    decision.descriptionWordCount = countWords(detailedDescription);
    return {
      decision,
      agent: {
        ...agentRun.agent,
        provider: 'ollama',
        model,
        visionClassificationApplied: visualClassificationApplied,
        summary: String(parsed.summary).trim().slice(0, 500),
        generatedDescription: detailedDescription,
        officialBrief,
        descriptionWordCount: countWords(detailedDescription),
        citizenMessage: String(parsed.citizenMessage).trim().slice(0, 500),
        modelRiskExplanation: String(parsed.riskExplanation || '').trim().slice(0, 500),
        modelEnrichedAt: new Date(),
      },
    };
  } catch (error) {
    console.warn(`Agent language layer unavailable; using policy output: ${error.message}`);
    return agentRun;
  }
};

const displayTime = (date) => date.toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const makeCaseId = () => `CR-${Math.floor(100000 + Math.random() * 900000)}`;

const normalizeCoordinates = (coordinates) => {
  const latitude = Number(coordinates?.latitude ?? coordinates?.lat);
  const longitude = Number(coordinates?.longitude ?? coordinates?.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
};

const normalizeLocationKey = (location) => String(location || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const photoFingerprintFor = (photoDataUrl) => {
  const value = String(photoDataUrl || '').trim();
  if (!value) return '';
  const base64 = value.replace(/^data:[^;]+;base64,/, '');
  try {
    return crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
  } catch (error) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
};

const duplicateQueryFor = ({ category = '', description = '', location = '', photoDataUrl = '', excludeId = null } = {}) => {
  const cleanCategory = String(category || '').trim();
  const cleanLocation = String(location || '').trim();
  const locationKey = normalizeLocationKey(cleanLocation);
  const photoFingerprint = photoFingerprintFor(photoDataUrl);
  const detectedProfile = findAgentProfile(cleanCategory, description);
  const categoryQuery = cleanCategory
    ? { $or: [{ category: cleanCategory }, { category: detectedProfile.category }] }
    : {};
  const duplicateSignals = [];

  if (photoFingerprint && locationKey) duplicateSignals.push({ photoFingerprint, locationKey });
  if (locationKey) duplicateSignals.push({ locationKey, ...categoryQuery });
  if (cleanLocation) duplicateSignals.push({ location: { $regex: escapeRegex(cleanLocation), $options: 'i' }, ...categoryQuery });
  if (!duplicateSignals.length) return null;
  const query = { $or: duplicateSignals };
  return excludeId ? { $and: [{ _id: { $ne: excludeId } }, query] } : query;
};

const findDuplicateCount = async (details) => {
  const query = duplicateQueryFor(details);
  return query && complaints ? complaints.countDocuments(query) : 0;
};

const officialAutoAssignRadiusKm = Number(process.env.OFFICIAL_AUTO_ASSIGN_RADIUS_KM || 5);

const distanceBetweenCoordinatesKm = (first, second) => {
  const origin = normalizeCoordinates(first);
  const target = normalizeCoordinates(second);
  if (!origin || !target) return null;
  const earthRadiusKm = 6371;
  const toRadians = (value) => value * Math.PI / 180;
  const latitudeDelta = toRadians(target.latitude - origin.latitude);
  const longitudeDelta = toRadians(target.longitude - origin.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(origin.latitude)) * Math.cos(toRadians(target.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const locationTextMatches = (firstLocation, secondLocation) => {
  const first = normalizeLocationKey(firstLocation);
  const second = normalizeLocationKey(secondLocation);
  if (!first || !second) return false;
  if (first === second || first.includes(second) || second.includes(first)) return true;
  const ignoredWords = new Set(['road', 'street', 'near', 'area', 'main', 'city', 'ward', 'zone', 'district']);
  const firstWords = new Set(first.split(' ').filter(word => word.length > 2 && !ignoredWords.has(word)));
  const commonWords = second.split(' ').filter(word => firstWords.has(word));
  return new Set(commonWords).size >= 2;
};

const findNearestOfficial = async (coordinates, complaintLocation = '', department = '') => {
  const complaintCoordinates = normalizeCoordinates(coordinates);
  if (!users) return null;
  const candidates = await users.find({ role: 'official' })
    .project({ name: 1, email: 1, department: 1, location: 1, coordinates: 1 })
    .toArray();
  return candidates
    .map((official) => ({
      ...official,
      coordinates: normalizeCoordinates(official.coordinates),
      distanceKm: complaintCoordinates ? distanceBetweenCoordinatesKm(complaintCoordinates, official.coordinates) : null,
      gpsMatch: Boolean(complaintCoordinates && official.coordinates && distanceBetweenCoordinatesKm(complaintCoordinates, official.coordinates) <= officialAutoAssignRadiusKm),
      workLocationMatch: locationTextMatches(complaintLocation, official.location),
    }))
    .filter((official) => (!department || official.department === department) && (official.gpsMatch || official.workLocationMatch))
    .sort((first, second) => Number(second.gpsMatch) - Number(first.gpsMatch) || (first.distanceKm ?? Number.MAX_SAFE_INTEGER) - (second.distanceKm ?? Number.MAX_SAFE_INTEGER))[0] || null;
};

const analyzeOfficialUpdate = async ({ complaint, status, note, photoDataUrl }) => {
  const photoProvided = Boolean(String(photoDataUrl || '').trim());
  const totalTasks = complaint.workOrder?.tasks?.length || 0;
  const completedTasks = complaint.workOrder?.tasks?.filter((task) => task.status === 'completed').length || 0;
  let progressPercent = status === 'Resolved'
    ? 100
    : totalTasks
      ? Math.min(95, Math.round((completedTasks / totalTasks) * 80) + (status === 'In Progress' ? 15 : 5))
      : ({ Assigned: 25, 'In Progress': 60, Escalated: 40 }[status] || 10);
  if (photoProvided && status !== 'Resolved') progressPercent = Math.min(95, progressPercent + 10);
  if (String(note || '').trim() && status !== 'Resolved') progressPercent = Math.min(95, progressPercent + 5);

  const fallback = {
    status,
    progressPercent,
    summary: String(note || '').trim() || (photoProvided ? 'Official progress photo received for agent verification.' : `Case status updated to ${status}.`),
    visibleEvidence: photoProvided ? 'Progress image attached for visual verification.' : 'No progress image attached to this update.',
    remainingWork: status === 'Resolved' ? 'No remaining work reported. Awaiting citizen confirmation if needed.' : 'Continue the assigned work and upload another update when the next milestone is complete.',
    citizenMessage: status === 'Resolved' ? 'The government official marked your case resolved and submitted completion evidence.' : `The responsible official updated your case to ${status}.`,
    photoAnalyzed: photoProvided,
    provider: 'policy-progress-agent',
    analyzedAt: new Date(),
  };
  if (!localModelEnabled() || !photoProvided) return fallback;

  const modelUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
  const model = process.env.OLLAMA_MODEL || 'gemma3:4b';
  const imageBase64 = String(photoDataUrl).replace(/^data:[^;]+;base64,/, '');
  const prompt = `You are the progress-verification layer of a civic response agent. Return ONLY valid JSON with keys progressPercent, summary, visibleEvidence, remainingWork, citizenMessage. Analyze the official update photo conservatively. Do not claim a repair is complete unless the official status is Resolved. The case category is ${complaint.category}; current status is ${status}; official note is ${String(note || 'No note')}. Estimate completion from 0 to 100, where Resolved must be 100. Keep every value concise and factual.`;
  try {
    const response = await fetch(modelUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt, images: [imageBase64] }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Local model returned HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = typeof payload.message?.content === 'string' ? JSON.parse(payload.message.content) : payload.message?.content;
    if (!parsed || !String(parsed.summary || '').trim()) throw new Error('Progress model returned an incomplete analysis.');
    return {
      ...fallback,
      progressPercent: status === 'Resolved' ? 100 : Math.max(0, Math.min(95, Number(parsed.progressPercent) || fallback.progressPercent)),
      summary: String(parsed.summary).trim().slice(0, 500),
      visibleEvidence: String(parsed.visibleEvidence || fallback.visibleEvidence).trim().slice(0, 500),
      remainingWork: String(parsed.remainingWork || fallback.remainingWork).trim().slice(0, 500),
      citizenMessage: String(parsed.citizenMessage || fallback.citizenMessage).trim().slice(0, 500),
      provider: 'ollama-progress-vision-agent',
      model,
    };
  } catch (error) {
    console.warn(`Official update vision layer unavailable; using policy analysis: ${error.message}`);
    return fallback;
  }
};

const notifyCitizen = async (complaint, status, progressAnalysis) => {
  if (!notifications) return null;
  const reporter = complaint.reporter || {};
  const recipientEmail = String(reporter.email || '').trim().toLowerCase();
  const recipientPhone = String(reporter.phone || '').trim();
  const recipientIdentifier = String(reporter.identifier || '').trim();
  if (!recipientEmail && !recipientPhone && !recipientIdentifier) return null;
  const resolved = status === 'Resolved';
  const notification = {
    notificationId: crypto.randomUUID(),
    recipientEmail,
    recipientPhone,
    recipientIdentifier,
    complaintId: complaint.id,
    type: resolved ? 'case-resolved' : 'case-progress',
    title: resolved ? 'Your civic complaint is resolved' : `Your civic complaint was updated to ${status}`,
    message: resolved
      ? `${progressAnalysis.citizenMessage} Case ${complaint.id}: ${progressAnalysis.summary}`
      : `Case ${complaint.id} is ${progressAnalysis.progressPercent}% complete. ${progressAnalysis.citizenMessage}`,
    progressPercent: progressAnalysis.progressPercent,
    read: false,
    createdAt: new Date(),
  };
  await notifications.insertOne(notification);
  return notification;
};

const makeWorkOrderId = () => `WO-${Math.floor(100000 + Math.random() * 900000)}`;

const workOrderStatusFor = (status) => ({
  Received: 'queued',
  Assigned: 'assigned',
  'In Progress': 'in-progress',
  Resolved: 'completed',
  Escalated: 'escalated',
}[status] || 'queued');

const buildWorkOrder = (decision, agentRunId, { status = 'queued', assignedTo = null, previousWorkOrderId = null, now = new Date() } = {}) => ({
  id: makeWorkOrderId(),
  title: `${decision.category} response work order`,
  status,
  department: decision.department,
  team: decision.team,
  priority: decision.priority,
  dueAt: decision.followUp?.nextCheckAt || null,
  assignedTo,
  tasks: (decision.recommendedActions || []).map((title, index) => ({ id: `task-${index + 1}`, title, status: status === 'completed' ? 'completed' : 'pending' })),
  sourceAgentRunId: agentRunId,
  previousWorkOrderId,
  createdBy: 'civicresolve-response-agent',
  createdAt: now,
  updatedAt: now,
});

const buildCitizenAssistantReply = (message, records) => {
  const question = String(message || '').trim();
  const normalizedQuestion = question.toLowerCase();
  if (!records.length) {
    return 'I could not find any complaints in your account yet. Upload a complaint photo and provide its location, and I will track the case for you.';
  }

  const requestedId = question.match(/\bCR-\d{6}\b/i)?.[0]?.toUpperCase();
  const selected = requestedId ? records.find((record) => record.id === requestedId) : records[0];
  if (requestedId && !selected) return `I could not find case ${requestedId} in your account. Please check the case ID and try again.`;

  const progressFor = (record) => record.status === 'Resolved' ? 100 : Number(record.progressPercent) || 0;
  const shortCase = (record) => `${record.id}: ${record.status}, ${progressFor(record)}% solved, ${record.category || 'civic issue'} at ${record.location || 'the submitted location'}.`;
  const latestNote = selected.progressAnalysis?.summary || selected.officialNotes?.at(-1)?.text || 'No official progress note has been added yet.';
  const assignedName = selected.assignedTo?.name || 'the government official queue';
  const latestTimelineEvent = selected.timeline?.at(-1)?.desc || 'The case has been received and is being monitored.';
  const remainingWork = selected.progressAnalysis?.remainingWork || selected.agent?.nextAction || selected.agentDecision?.nextAction || 'The assigned official must inspect the location and post the next update.';
  const recommendedActions = selected.agentDecision?.recommendedActions || selected.agent?.recommendedActions || [];
  const riskFlags = selected.agentDecision?.riskFlags || selected.agent?.riskFlags || [];
  const completedTasks = selected.workOrder?.tasks?.filter(task => task.status === 'completed').length || 0;
  const totalTasks = selected.workOrder?.tasks?.length || 0;

  if (/past|history|all|complaints|cases/.test(normalizedQuestion)) {
    return `Here is your latest complaint history:\n${records.slice(0, 5).map(shortCase).join('\n')}`;
  }

  const statusReply = `Case ${selected.id} is currently ${selected.status} and ${progressFor(selected)}% solved. It is routed to ${selected.department || 'the responsible civic department'}${selected.team ? ` (${selected.team})` : ''}, and is assigned to ${assignedName}. Expected response or resolution: ${selected.eta || 'being reviewed by the official'}. Latest update: ${latestNote}`;
  if (/duplicate|similar|same|already|repeat|recurring/.test(normalizedQuestion)) {
    const matches = records.filter(record => record.id !== selected.id && (
      (record.photoFingerprint && selected.photoFingerprint && record.photoFingerprint === selected.photoFingerprint)
      || (record.category && selected.category && record.category === selected.category && locationTextMatches(record.location, selected.location))
      || locationTextMatches(record.location, selected.location)
    ));
    return matches.length
      ? `The Investigation Agent found ${matches.length} similar case${matches.length === 1 ? '' : 's'} for ${selected.id}:\n${matches.slice(0, 5).map(shortCase).join('\n')}\nThe government official can link these reports while keeping each citizen's evidence.`
      : `The Investigation Agent did not find another matching case for ${selected.id} in your complaint history. This report is being treated as a separate case.`;
  }
  if (/where|location|place|address|gps|coordinates|landmark/.test(normalizedQuestion)) {
    const gpsText = selected.coordinates || selected.reporter?.coordinates
      ? `GPS coordinates: ${Number((selected.coordinates || selected.reporter.coordinates).latitude).toFixed(6)}, ${Number((selected.coordinates || selected.reporter.coordinates).longitude).toFixed(6)}.`
      : 'No GPS coordinates were captured; the citizen-provided landmark is the routing reference.';
    return `Case ${selected.id} was reported at ${selected.location || 'the submitted location'}. ${gpsText} The agent used this location to choose ${selected.department || 'the responsible department'} and route the case to the government official queue.`;
  }
  if (/what problem|which problem|category|classified|classification|type|description|summary|photo|image|agent.*understand/.test(normalizedQuestion)) {
    return `The Civic Intelligence Agent classified ${selected.id} as ${selected.category || 'a civic issue'}. Summary: ${selected.summary || selected.description || 'The submitted photo and location are awaiting official verification.'} The responsible department is ${selected.department || 'pending routing'}.`;
  }
  if (/department|who|official|assigned|responsible|team|owner/.test(normalizedQuestion)) {
    return `Case ${selected.id} belongs to the ${selected.department || 'responsible civic department'}${selected.team ? `, ${selected.team}` : ''}. Assigned official: ${assignedName}. Handoff status: ${selected.officialHandoff?.status || 'queued'}.`;
  }
  if (/how much|progress|percent|done|solved|complete|work order|task/.test(normalizedQuestion)) {
    const taskText = totalTasks ? ` ${completedTasks} of ${totalTasks} work-order tasks are complete.` : '';
    return `Case ${selected.id} is ${progressFor(selected)}% solved and currently ${selected.status}.${taskText} ${selected.status === 'Resolved' ? 'The official marked it resolved and completion evidence is available.' : `Remaining work: ${remainingWork}`}`;
  }
  if (/when|eta|how long|time|response|resolve|finish|finished|deadline/.test(normalizedQuestion)) {
    return selected.status === 'Resolved'
      ? `Case ${selected.id} was marked resolved. ${selected.officialNotes?.at(-1)?.text || 'The completion evidence is available in your case timeline.'}`
      : `The expected response or resolution window for ${selected.id} is ${selected.eta || 'being reviewed by the official'}. It is currently ${selected.status}. The next update should explain: ${remainingWork}`;
  }
  if (/why|priority|urgent|urgency|impact|important|risk|critical/.test(normalizedQuestion)) {
    const riskText = riskFlags.length ? ` Risk signals: ${riskFlags.join(', ')}.` : '';
    return `The Decision Agent marked ${selected.id} as ${selected.priority || 'priority pending'} with ${selected.urgency || 'medium'} urgency and an impact score of ${selected.impactScore ?? 'pending'}/100.${riskText} This helps officials order work; the official must verify the situation in the field.`;
  }
  if (/next|what should|action|do now|follow|escalat|update/.test(normalizedQuestion)) {
    const planText = recommendedActions.length ? ` Recommended plan: ${recommendedActions.join('; ')}.` : '';
    return `${statusReply} Next action: ${remainingWork}.${planText} Latest timeline event: ${latestTimelineEvent}`;
  }
  return `Here is the latest agent snapshot for ${selected.id}: ${selected.category || 'civic issue'} at ${selected.location || 'the submitted location'}, ${selected.status}, ${progressFor(selected)}% solved, assigned to ${assignedName}. Ask me about its status, department, location, duplicates, priority, ETA or next action.`;
};

const formatOverdueDuration = (hours) => {
  const safeHours = Math.max(1, Math.round(Number(hours) || 1));
  if (safeHours >= 24) {
    const days = Math.floor(safeHours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  return `${safeHours} hour${safeHours === 1 ? '' : 's'}`;
};

const buildOfficialIntelligence = (records = [], { department = '', availableWorkers = null, resources = '', now = new Date() } = {}) => {
  const currentTime = new Date(now).getTime();
  const openStatuses = new Set(['Received', 'Assigned', 'In Progress', 'Escalated']);
  const openCases = records.filter((record) => openStatuses.has(record.status));
  const highPriorityRecords = openCases
    .filter((record) => record.priority === 'Critical' || Number(record.impactScore) >= 80)
    .sort((first, second) => Number(second.impactScore || 0) - Number(first.impactScore || 0));
  const pendingRecords = records.filter((record) => ['Received', 'Assigned', 'In Progress'].includes(record.status));
  const caseDueAt = (record) => new Date(record.workOrder?.dueAt || record.agent?.followUp?.nextCheckAt || 0);
  const overdueRecords = openCases
    .map((record) => {
      const dueAt = caseDueAt(record);
      const dueTime = dueAt.getTime();
      const overdueByHours = record.status === 'Escalated'
        ? Math.max(1, Math.round((currentTime - (dueTime > 0 ? dueTime : new Date(record.updatedAt || record.createdAt || now).getTime())) / (60 * 60 * 1000)))
        : dueTime > 0 && dueTime < currentTime
          ? Math.max(1, Math.round((currentTime - dueTime) / (60 * 60 * 1000)))
          : 0;
      return { record, dueAt: dueTime > 0 ? dueAt : null, overdueByHours };
    })
    .filter((item) => item.overdueByHours > 0)
    .sort((first, second) => second.overdueByHours - first.overdueByHours);
  const duplicateRecords = records.filter((record) => Number(record.duplicates || record.agentDecision?.duplicateCount || 0) > 0);
  const preview = (record, extra = {}) => ({
    id: record.id,
    category: record.category || 'Civic issue',
    location: record.location || 'Location pending',
    department: record.department || department || 'Unassigned department',
    team: record.team || record.workOrder?.team || 'Civic response team',
    status: record.status || 'Received',
    priority: record.priority || 'Priority pending',
    impactScore: Number(record.impactScore) || 0,
    progressPercent: record.status === 'Resolved' ? 100 : Number(record.progressPercent) || 0,
    duplicates: Number(record.duplicates || record.agentDecision?.duplicateCount || 0),
    assignedTo: record.assignedTo?.name || 'Available to claim',
    createdAt: record.createdAt || null,
    ...extra,
  });

  const recentRecords = records.filter((record) => currentTime - new Date(record.createdAt || now).getTime() <= 30 * 24 * 60 * 60 * 1000);
  const locationGroups = new Map();
  recentRecords.forEach((record) => {
    const location = String(record.location || 'Location pending').trim();
    const key = `${record.category || 'Civic issue'}|${normalizeLocationKey(location) || location.toLowerCase()}`;
    const group = locationGroups.get(key) || { category: record.category || 'Civic issue', location, records: [] };
    group.records.push(record);
    locationGroups.set(key, group);
  });
  const recurringProblems = [...locationGroups.values()]
    .filter((group) => group.records.length >= 2)
    .sort((first, second) => second.records.length - first.records.length)
    .slice(0, 10)
    .map((group) => ({
      category: group.category,
      location: group.location,
      count: group.records.length,
      open: group.records.filter((record) => record.status !== 'Resolved').length,
      recommendation: recommendationFor(group.category),
    }));
  const areaAnalysis = [...locationGroups.values()]
    .sort((first, second) => second.records.length - first.records.length)
    .slice(0, 10)
    .map((group) => ({
      category: group.category,
      location: group.location,
      count: group.records.length,
      open: group.records.filter((record) => record.status !== 'Resolved').length,
      periodDays: 30,
      statement: `${group.records.length} ${group.category.toLowerCase()} complaint${group.records.length === 1 ? '' : 's'} reported in this area during the last 30 days.`,
    }));
  const assignmentRecommendations = records
    .filter((record) => !record.assignedTo && record.status !== 'Resolved')
    .slice(0, 10)
    .map((record) => ({
      ...preview(record),
      recommendation: `Assign ${record.id} to ${record.department || department || 'the responsible department'} / ${record.team || record.workOrder?.team || 'the response team'}.`,
    }));
  const departmentCounts = records.reduce((counts, record) => {
    const name = record.department || 'Unassigned department';
    const current = counts[name] || { department: name, total: 0, open: 0, highPriority: 0, overdue: 0 };
    current.total += 1;
    if (record.status !== 'Resolved') current.open += 1;
    if (record.priority === 'Critical' || Number(record.impactScore) >= 80) current.highPriority += 1;
    if (overdueRecords.some((item) => item.record.id === record.id)) current.overdue += 1;
    counts[name] = current;
    return counts;
  }, {});
  const workerCount = Number.isFinite(Number(availableWorkers)) && Number(availableWorkers) >= 0 ? Number(availableWorkers) : null;
  const capacity = {
    availableWorkers: workerCount,
    resources: String(resources || '').trim(),
    openCases: openCases.length,
    casesPerWorker: workerCount > 0 ? Number((openCases.length / workerCount).toFixed(1)) : null,
    status: workerCount === null ? 'Officer has not provided team capacity yet.' : workerCount === 0 ? 'No available workers reported; supervisor support is recommended.' : openCases.length > workerCount * 5 ? 'High workload: request additional workers or resources.' : 'Capacity is available for the visible queue.',
  };
  return {
    generatedAt: now,
    department: department || null,
    counts: { total: records.length, open: openCases.length, highPriority: highPriorityRecords.length, pending: pendingRecords.length, overdue: overdueRecords.length, duplicates: duplicateRecords.length, recurringLocations: recurringProblems.length, resolved: records.filter((record) => record.status === 'Resolved').length },
    highPriorityCases: highPriorityRecords.slice(0, 12).map((record) => preview(record)),
    pendingCases: pendingRecords.slice(0, 12).map((record) => preview(record)),
    overdueCases: overdueRecords.slice(0, 12).map(({ record, dueAt, overdueByHours }) => preview(record, { slaDueAt: dueAt, overdueByHours, overdueBy: formatOverdueDuration(overdueByHours) })),
    duplicateCases: duplicateRecords.slice(0, 12).map((record) => preview(record)),
    recurringProblems,
    areaAnalysis,
    assignmentRecommendations,
    departmentSummary: Object.values(departmentCounts).sort((first, second) => second.open - first.open),
    capacity,
    agent: { id: 'government-operations-intelligence-agent', name: 'Government Operations Intelligence Agent', role: 'official-facing-intelligence-agent', sources: ['complaint cases', 'department routing', 'SLA timestamps', 'duplicate memory', 'location clusters', 'officer workforce/resources'] },
  };
};

const buildOfficialAssistantReply = (message, records, intelligence = buildOfficialIntelligence(records)) => {
  const question = String(message || '').trim();
  const normalizedQuestion = question.toLowerCase();
  if (!records.length) return 'There are no complaints in your visible official queue right now.';

  const requestedId = question.match(/\bCR-\d{6}\b/i)?.[0]?.toUpperCase();
  const selected = requestedId ? records.find((record) => record.id === requestedId) : null;
  const categoryHint = [
    ['road', 'Roads & Potholes'],
    ['pothole', 'Roads & Potholes'],
    ['drain', 'Drainage & Flooding'],
    ['flood', 'Drainage & Flooding'],
    ['waste', 'Waste Management'],
    ['garbage', 'Waste Management'],
    ['water', 'Water Supply'],
    ['streetlight', 'Streetlights'],
    ['light', 'Streetlights'],
    ['facility', 'Public Facilities'],
  ].find(([term]) => normalizedQuestion.includes(term))?.[1];
  const relevant = categoryHint ? records.filter(record => record.category === categoryHint) : records;
  const openCases = records.filter(record => record.status !== 'Resolved');
  const delayedCases = records.filter(record => record.status === 'Escalated');
  const shortCase = (record) => `${record.id}: ${record.category || 'civic issue'} at ${record.location || 'unknown location'} (${record.status}, ${record.status === 'Resolved' ? 100 : Number(record.progressPercent) || 0}% solved)`;
  const departmentCounts = records.reduce((counts, record) => {
    const department = record.department || 'Unassigned department';
    counts[department] = (counts[department] || 0) + 1;
    return counts;
  }, {});
  const intelligenceHighPriority = intelligence.highPriorityCases || [];
  const intelligencePending = intelligence.pendingCases || [];
  const intelligenceOverdue = intelligence.overdueCases || [];
  const intelligenceRecurring = intelligence.recurringProblems || [];

  if (requestedId && !selected) return `Case ${requestedId} is not in your visible official queue.`;
  if (/similar|duplicate|same|like that|repeated/.test(normalizedQuestion)) {
    if (selected) {
      const matches = records.filter(record => record.id !== selected.id && (record.category === selected.category || locationTextMatches(record.location, selected.location)));
      return matches.length
        ? `Case ${selected.id} has ${matches.length} similar visible case${matches.length === 1 ? '' : 's'} based on category or location:\n${matches.slice(0, 8).map(shortCase).join('\n')}`
        : `I did not find another visible case matching ${selected.category || 'this category'} or ${selected.location || 'this location'}.`;
    }
    return relevant.length
      ? `I found ${relevant.length} visible ${categoryHint || 'case'} record${relevant.length === 1 ? '' : 's'} that may represent the same problem:\n${relevant.slice(0, 8).map(shortCase).join('\n')}`
      : 'I did not find similar cases in your visible queue.';
  }
  if (/high.?priority|critical|urgent cases|important cases/.test(normalizedQuestion)) {
    return intelligenceHighPriority.length
      ? `The Decision Agent found ${intelligenceHighPriority.length} high-priority case${intelligenceHighPriority.length === 1 ? '' : 's'} in your visible queue:\n${intelligenceHighPriority.slice(0, 8).map((record) => shortCase(records.find((item) => item.id === record.id) || record)).join('\n')}`
      : 'There are no high-priority cases in your visible queue.';
  }
  if (/pending|waiting|not started|open cases/.test(normalizedQuestion)) {
    return intelligencePending.length
      ? `${intelligencePending.length} cases are pending or in progress. The oldest visible cases are:\n${intelligencePending.slice(0, 8).map((record) => shortCase(records.find((item) => item.id === record.id) || record)).join('\n')}`
      : 'There are no pending cases in your visible queue.';
  }
  if (/delay|late|escalat/.test(normalizedQuestion)) {
    return intelligenceOverdue.length
      ? `${intelligenceOverdue.length} case${intelligenceOverdue.length === 1 ? '' : 's'} exceeded the SLA or are escalated:\n${intelligenceOverdue.slice(0, 8).map((record) => `${record.id}: ${record.category} at ${record.location} (${record.overdueBy} overdue, ${record.status})`).join('\n')}\nEscalation and supervisor review are recommended.`
      : 'There are no overdue or escalated cases in your visible queue.';
  }
  if (/area|last 30|30 days|hotspot|recurring|permanent|recommend/.test(normalizedQuestion)) {
    return intelligenceRecurring.length
      ? `Area Intelligence Agent findings:\n${intelligenceRecurring.slice(0, 6).map((item) => `${item.count} ${item.category} reports at ${item.location}; ${item.open} remain open. Recommendation: ${item.recommendation}`).join('\n')}`
      : 'No repeated location pattern has been detected in the last 30 days. Continue monitoring new complaints.';
  }
  if (/worker|resource|crew|capacity|staff|material/.test(normalizedQuestion)) {
    const capacity = intelligence.capacity || {};
    return `Workforce and resource status: ${capacity.availableWorkers === null ? 'available worker count not provided' : `${capacity.availableWorkers} worker${capacity.availableWorkers === 1 ? '' : 's'} available`}; ${capacity.openCases} open visible cases. ${capacity.resources ? `Recorded resources: ${capacity.resources}. ` : ''}${capacity.status}`;
  }
  if (/department|workload|owner|team/.test(normalizedQuestion)) {
    const ranking = Object.entries(departmentCounts).sort((first, second) => second[1] - first[1]);
    return ranking.length
      ? `Cases by responsible department:\n${ranking.map(([department, count]) => `${department}: ${count}`).join('\n')}`
      : 'No department workload data is available yet.';
  }
  if (/how many|count|filed|queue|total/.test(normalizedQuestion)) {
    return categoryHint
      ? `There are ${relevant.length} ${categoryHint} case${relevant.length === 1 ? '' : 's'} in your visible queue, including ${relevant.filter(record => record.status === 'Resolved').length} resolved and ${relevant.filter(record => record.status !== 'Resolved').length} open.`
      : `Your visible queue contains ${records.length} case${records.length === 1 ? '' : 's'}: ${openCases.length} open, ${delayedCases.length} escalated and ${records.length - openCases.length} resolved.`;
  }
  if (selected) return shortCase(selected) + `. Department: ${selected.department || 'not assigned'}. Team: ${selected.team || 'not assigned'}. Next action: ${selected.agent?.nextAction || selected.agentDecision?.nextAction || 'inspect and update the case.'}`;
  return `Your visible queue has ${openCases.length} open case${openCases.length === 1 ? '' : 's'}. Ask me how many cases are filed, which cases are similar, or which cases are delayed.`;
};

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
    identifier: user.email || user.phone || '',
    email: user.email,
    phone: user.phone || '',
    name: user.name || '',
    department: user.department || '',
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

const sendPasswordResetOtp = async (email, otp) => {
  if (!mailTransport) throw new Error('Email OTP is not configured. Add SMTP_PASS to .env.');
  const sender = process.env.OTP_FROM || process.env.SMTP_USER;
  return mailTransport.sendMail({
    from: `CivicResolve <${sender}>`,
    to: email,
    subject: 'Reset your CivicResolve password',
    text: `Your CivicResolve password reset code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<p>Your CivicResolve password reset code is:</p><h2 style="letter-spacing:4px">${otp}</h2><p>This code expires in 10 minutes. If you did not request this, ignore this email.</p>`,
  });
};

const databaseRequired = (handler) => async (req, res, next) => {
  if (!complaints) {
    return res.status(503).json({ message: 'MongoDB is not connected. Check MONGODB_URI and start the API again.' });
  }
  return handler(req, res, next);
};

const citizenRequired = (handler) => async (req, res, next) => {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ message: 'Please sign in to access your citizen workspace.' });
  if (session.role !== 'citizen') return res.status(403).json({ message: 'This workspace is available to citizen accounts only.' });
  req.session = session;
  return handler(req, res, next);
};

const recommendationFor = (category) => {
  if (/road|pothole/i.test(category)) return 'Review the cluster for permanent resurfacing instead of repeated patch repairs.';
  if (/drain|flood/i.test(category)) return 'Inspect drainage capacity and plan a permanent flow or culvert improvement.';
  if (/waste/i.test(category)) return 'Audit the collection route and adjust service frequency for this location.';
  if (/streetlight/i.test(category)) return 'Bundle nearby fixture repairs into one electrical maintenance round.';
  if (/water/i.test(category)) return 'Inspect the local supply network for a repeat leak or pressure issue.';
  return 'Create a location-level maintenance plan and monitor new reports.';
};

const reviewDelayedComplaints = async () => {
  if (!complaints) return { escalated: 0 };
  const now = new Date();
  const openCases = await complaints.find({ status: { $in: ['Received', 'Assigned', 'In Progress'] } }).limit(250).toArray();
  let escalated = 0;

  for (const complaint of openCases) {
    const lastActivity = new Date(complaint.updatedAt || complaint.createdAt || now).getTime();
    const thresholdHours = Number(complaint.agent?.followUp?.thresholdHours) || followUpHoursFor(complaint.urgency);
    if (now.getTime() - lastActivity < thresholdHours * 60 * 60 * 1000) continue;

    const result = await complaints.updateOne(
      { _id: complaint._id, status: complaint.status },
      {
        $set: {
          status: 'Escalated',
          escalatedAt: now,
          updatedAt: now,
          'agent.followUp.status': 'escalated',
          'agent.followUp.escalatedAt': now,
          'workOrder.status': 'escalated',
          'workOrder.updatedAt': now,
        },
        $push: {
          timeline: {
            time: displayTime(now),
            title: 'Agent Escalation',
            desc: `No progress update received within ${thresholdHours} hours. Supervisor review requested.`,
            done: false,
            actor: 'civicresolve-response-agent',
          },
          'agent.events': {
            type: 'escalation',
            createdAt: now,
            reason: `Case exceeded the ${thresholdHours}-hour follow-up window.`,
          },
        },
      },
    );
    if (result.modifiedCount) escalated += 1;
  }
  return { escalated };
};

const buildAgentInsights = async () => {
  const records = await complaints.find({}).project({ category: 1, location: 1, status: 1, impactScore: 1, createdAt: 1, department: 1 }).limit(2000).toArray();
  const categoryCounts = new Map();
  const hotspotCounts = new Map();

  records.forEach((record) => {
    const category = String(record.category || 'Other');
    const location = String(record.location || 'Unknown location').trim();
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    const key = `${category.toLowerCase()}|${location.toLowerCase()}`;
    const existing = hotspotCounts.get(key) || { category, location, count: 0, open: 0, maxImpact: 0 };
    existing.count += 1;
    existing.open += record.status === 'Resolved' ? 0 : 1;
    existing.maxImpact = Math.max(existing.maxImpact, Number(record.impactScore) || 0);
    hotspotCounts.set(key, existing);
  });

  const categoryBreakdown = [...categoryCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
  const recurringProblems = [...hotspotCounts.values()]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count || b.maxImpact - a.maxImpact)
    .slice(0, 10)
    .map((item) => ({ ...item, recommendation: recommendationFor(item.category) }));

  return {
    generatedAt: new Date(),
    totalComplaints: records.length,
    categoryBreakdown,
    hotspots: recurringProblems.slice(0, 5),
    recurringProblems,
    agentSummary: recurringProblems.length
      ? `The agent found ${recurringProblems.length} recurring location problem${recurringProblems.length === 1 ? '' : 's'} that may need permanent intervention.`
      : 'The agent has not found enough repeated reports to identify a recurring location problem yet.',
  };
};

const sessionRequired = (roles, handler) => databaseRequired(async (req, res, next) => {
  const session = sessionFromRequest(req);
  if (!session || !roles.includes(session.role)) {
    return res.status(403).json({ message: 'An authenticated account with the required role is needed.' });
  }
  req.session = session;
  return handler(req, res, next);
});

const officialRequired = (handler) => sessionRequired(['official', 'admin'], handler);

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
    department = '', location = '', coordinates = null,
  } = req.body || {};
  const normalizedEmail = String(email).trim().toLowerCase();
  const cleanDepartment = String(department || '').trim();

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
  if (role === 'official' && !officialDepartmentOptions.includes(cleanDepartment)) {
    return res.status(400).json({ message: 'Government officials must select their responsible department.' });
  }
  const normalizedCoordinates = normalizeCoordinates(coordinates);
  if (role === 'official' && !normalizedCoordinates) {
    return res.status(400).json({ message: 'Government officials must share their current GPS office location.' });
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
    department: role === 'official' ? cleanDepartment : '',
    location: String(location).trim(),
    coordinates: normalizedCoordinates,
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
      department: pendingSignup.department,
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
    department: pendingSignup.department || '',
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
    user: { name: user.name, email: user.email, phone: user.phone, department: user.department || '', location: user.location, coordinates: user.coordinates, role: user.role },
  });
}));

app.post('/api/auth/forgot-password/request-otp', databaseRequired(async (req, res) => {
  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
  const requestedRole = String(req.body?.requestedRole || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({ message: 'Please enter the email used for your account.' });
  }

  const user = await users.findOne({ email: normalizedEmail });
  if (!user || (requestedRole && user.role !== requestedRole)) {
    return res.json({ message: 'If an account matches that email, a password reset OTP has been sent.' });
  }

  const recentReset = await passwordResets.findOne({
    email: normalizedEmail,
    createdAt: { $gt: new Date(Date.now() - 60 * 1000) },
  });
  if (recentReset) return res.status(429).json({ message: 'Please wait one minute before requesting another reset OTP.' });

  const otp = String(crypto.randomInt(100000, 1000000));
  const resetRequest = {
    email: normalizedEmail,
    otpHash: hashOtp(normalizedEmail, otp),
    attempts: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  };
  await passwordResets.deleteMany({ email: normalizedEmail });
  await passwordResets.insertOne(resetRequest);
  try {
    const delivery = await sendPasswordResetOtp(normalizedEmail, otp);
    console.log(`Password reset OTP accepted for recipient ${normalizedEmail}: ${delivery.accepted?.join(', ') || 'unknown'}`);
  } catch (error) {
    await passwordResets.deleteOne({ _id: resetRequest._id });
    console.error('Unable to send password reset OTP:', error.message);
    return res.status(503).json({ message: 'Unable to send the reset email. Check SMTP settings in .env.' });
  }

  return res.json({ message: 'A password reset OTP has been sent to your registered email address.' });
}));

app.post('/api/auth/forgot-password/reset', databaseRequired(async (req, res) => {
  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
  const otp = String(req.body?.otp || '').trim();
  const newPassword = String(req.body?.newPassword || '');
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Enter the registered email and 6-digit OTP.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'New password must be at least 8 characters.' });
  }

  const resetRequest = await passwordResets.findOne({ email: normalizedEmail });
  if (!resetRequest || resetRequest.expiresAt <= new Date()) {
    await passwordResets.deleteMany({ email: normalizedEmail });
    return res.status(400).json({ message: 'This reset OTP has expired. Request a new one.' });
  }
  if (resetRequest.attempts >= 5) {
    await passwordResets.deleteMany({ email: normalizedEmail });
    return res.status(429).json({ message: 'Too many incorrect OTP attempts. Request a new reset OTP.' });
  }
  if (hashOtp(normalizedEmail, otp) !== resetRequest.otpHash) {
    await passwordResets.updateOne({ _id: resetRequest._id }, { $inc: { attempts: 1 } });
    return res.status(401).json({ message: 'Incorrect reset OTP.' });
  }

  const { passwordHash, passwordSalt } = await hashPassword(newPassword);
  const result = await users.updateOne(
    { email: normalizedEmail },
    { $set: { passwordHash, passwordSalt, passwordChangedAt: new Date() } },
  );
  await passwordResets.deleteOne({ _id: resetRequest._id });
  for (const [token, session] of sessions.entries()) {
    if (session.email === normalizedEmail) sessions.delete(token);
  }
  if (!result.matchedCount) return res.status(404).json({ message: 'Account not found.' });
  return res.json({ message: 'Password updated successfully. You can now sign in with your new password.' });
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
    if (!user && normalizedRequestedRole === 'official' && await officialRequests.findOne({ email: normalizedIdentifier, status: 'pending' })) {
      return res.status(403).json({ message: 'This government-official account is waiting for admin approval. Sign in after the administrator approves it.' });
    }
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
      department: user.department || '',
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
  department: request.department || '',
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
    department: request.department || '',
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

app.post('/api/agent/preview', databaseRequired(async (req, res) => {
  const { category = '', description = '', location = '', urgency = 'medium', photoDataUrl = '', coordinates = null } = req.body || {};
  if (!String(category).trim() && !String(description).trim() && !String(photoDataUrl).trim()) {
    return res.status(400).json({ message: 'Add a complaint description or photo before running agent triage.' });
  }

  const cleanCategory = String(category || '').trim();
  const cleanLocation = String(location || '').trim() || 'Location pending field verification';
  const duplicateCount = await findDuplicateCount({ category: cleanCategory, description, location: cleanLocation, photoDataUrl });
  const agentDraft = await enrichResponseAgent({ category: cleanCategory, description, location: cleanLocation, photoDataUrl }, buildResponseAgent({ category: cleanCategory, description, location: cleanLocation, urgency, photoDataUrl, coordinates }, duplicateCount));
  return res.json(agentDraft);
}));

app.get('/api/agent/insights', databaseRequired(async (req, res) => {
  return res.json(await buildAgentInsights());
}));

app.get('/api/agent/escalations', officialRequired(async (req, res) => {
  const records = await complaints.find({ status: 'Escalated' }).sort({ updatedAt: -1 }).limit(100).toArray();
  return res.json(records);
}));

app.post('/api/complaints', databaseRequired(async (req, res) => {
  const {
    category, description, location, urgency = 'medium',
    name = '', phone = '', photoDataUrl = '', reporter = null, coordinates = null,
  } = req.body || {};

  if (!String(category || '').trim() && !String(description || '').trim() && !String(photoDataUrl || '').trim()) {
    return res.status(400).json({ message: 'Add a complaint description or photo before submitting.' });
  }

  if (!['low', 'medium', 'high'].includes(urgency)) {
    return res.status(400).json({ message: 'Urgency must be low, medium, or high.' });
  }

  if (typeof photoDataUrl === 'string' && photoDataUrl.length > 5_000_000) {
    return res.status(413).json({ message: 'The selected photo is too large. Please choose an image under 4 MB.' });
  }

  const createdAt = new Date();
  const cleanCategory = String(category || '').trim();
  const cleanLocation = String(location || '').trim() || 'Location pending field verification';
  const duplicateCount = await findDuplicateCount({ category: cleanCategory, description, location: cleanLocation, photoDataUrl });
  const agentRun = await enrichResponseAgent({ category: cleanCategory, description, location: cleanLocation, photoDataUrl }, buildResponseAgent({ category: cleanCategory, description, location: cleanLocation, urgency, photoDataUrl, coordinates: coordinates || reporter?.coordinates || null, createdAt }, duplicateCount));
  const decision = agentRun.decision;
  const complaintCoordinates = normalizeCoordinates(coordinates || reporter?.coordinates);
  const complaintLocationKey = normalizeLocationKey(cleanLocation);
  const complaintPhotoFingerprint = photoFingerprintFor(photoDataUrl);
  const nearestOfficial = await findNearestOfficial(complaintCoordinates, cleanLocation, decision.department);
  const assignedDistanceKm = nearestOfficial?.distanceKm === null || nearestOfficial?.distanceKm === undefined
    ? null
    : Number(nearestOfficial.distanceKm.toFixed(2));
  const assignedTo = nearestOfficial ? {
    email: nearestOfficial.email,
    name: nearestOfficial.name,
    officeLocation: nearestOfficial.location || '',
    officeCoordinates: nearestOfficial.coordinates,
    distanceKm: assignedDistanceKm,
    matchMethod: nearestOfficial.gpsMatch ? 'gps' : 'work-location-text',
    matchReason: nearestOfficial.gpsMatch ? `Office is within ${assignedDistanceKm} km of complaint GPS.` : 'Complaint location matches the official registered work location.',
    autoAccepted: true,
    acceptedAt: createdAt,
  } : null;
  const initialStatus = assignedTo ? 'Assigned' : 'Received';
  const officialHandoff = {
    ...(decision.officialHandoff || {}),
    status: assignedTo ? 'auto-assigned' : 'queued',
    recipient: assignedTo ? assignedTo.name : 'Government Official Queue',
    department: decision.department,
    team: decision.team,
    distanceKm: assignedTo?.distanceKm ?? null,
    assignmentMethod: assignedTo?.matchMethod || null,
    assignmentReason: assignedTo?.matchReason || null,
    routedAt: createdAt,
  };
  decision.officialHandoff = officialHandoff;
  const responseAgent = { ...agentRun.agent, officialHandoff };
  const workOrder = buildWorkOrder(decision, responseAgent.runId, { status: workOrderStatusFor(initialStatus), assignedTo, now: createdAt });
  const timeline = [{
    time: displayTime(createdAt),
    title: 'Complaint Received',
    desc: 'Response Agent triaged, prioritized and routed the complaint',
    done: true,
  }, {
    time: displayTime(createdAt),
    title: assignedTo ? 'Automatically Accepted by Location-Matched Official' : 'Sent to Government Official Queue',
    desc: assignedTo
      ? assignedTo.matchMethod === 'gps'
        ? `${assignedTo.name} accepted this case because the office is ${assignedTo.distanceKm} km from the GPS location`
        : `${assignedTo.name} accepted this case because the complaint location matches the registered work location`
      : `${decision.department} / ${decision.team} received the agent-generated case and work order`,
    done: true,
  }];

  const complaint = {
    id: makeCaseId(),
    category: decision.category,
    description: String(description || '').trim(),
    summary: decision.summary,
    agentGeneratedDescription: decision.detailedDescription,
    agentOfficialBrief: decision.officialBrief,
    location: cleanLocation,
    locationKey: complaintLocationKey,
    urgency: decision.urgency,
    coordinates: complaintCoordinates,
    name: String(name).trim(),
    phone: String(phone).trim(),
    reporter,
    photoDataUrl: typeof photoDataUrl === 'string' ? photoDataUrl : '',
    photoFingerprint: complaintPhotoFingerprint,
    department: decision.department,
    team: decision.team,
    priority: decision.priority,
    impactScore: decision.impactScore,
    duplicates: decision.duplicateCount,
    eta: decision.eta,
    agentDecision: decision,
    agent: responseAgent,
    workOrder,
    officialHandoff,
    progressPercent: 0,
    progressAnalysis: null,
    progressUpdates: [],
    status: initialStatus,
    assignedTo,
    officialNotes: [],
    resolutionPhotos: [],
    timeline,
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

app.get('/api/citizen/complaints', citizenRequired(databaseRequired(async (req, res) => {
  const session = req.session;
  const identityValues = [session.identifier, session.email, session.phone].map(value => String(value || '').trim()).filter(Boolean);
  const records = await complaints.find({
    $or: [
      { 'reporter.identifier': { $in: identityValues } },
      { 'reporter.email': session.email },
      ...(session.phone ? [{ 'reporter.phone': session.phone }] : []),
    ],
  }).sort({ createdAt: -1 }).limit(100).toArray();
  return res.json(records);
})));

app.get('/api/citizen/notifications', citizenRequired(databaseRequired(async (req, res) => {
  const session = req.session;
  const filters = [{ recipientEmail: session.email }];
  if (session.phone) filters.push({ recipientPhone: session.phone });
  if (session.identifier) filters.push({ recipientIdentifier: session.identifier });
  const records = await notifications.find({ $or: filters }).sort({ createdAt: -1 }).limit(50).toArray();
  return res.json(records);
})));

app.post('/api/citizen/assistant', citizenRequired(databaseRequired(async (req, res) => {
  const session = req.session;
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ message: 'Ask the Citizen Assistance Agent a question.' });
  if (message.length > 1000) return res.status(400).json({ message: 'Please keep your question under 1,000 characters.' });
  const identityValues = [session.identifier, session.email, session.phone].map(value => String(value || '').trim()).filter(Boolean);
  const records = await complaints.find({
    $or: [
      { 'reporter.identifier': { $in: identityValues } },
      { 'reporter.email': session.email },
      ...(session.phone ? [{ 'reporter.phone': session.phone }] : []),
    ],
  }).sort({ createdAt: -1 }).limit(100).toArray();
  return res.json({
    reply: buildCitizenAssistantReply(message, records),
    agent: {
      id: 'citizen-status-agent',
      name: 'Citizen Assistance Agent',
      role: 'citizen-facing-status-agent',
      sources: ['your complaint records', 'official updates', 'agent case timeline', 'work-order progress'],
    },
    context: { caseCount: records.length, latestCaseId: records[0]?.id || null },
  });
})));

const officialComplaintScope = (email, department = '', role = 'official') => {
  if (role === 'admin') return {};
  const availableCases = department
    ? [{ department, assignedTo: null }, { department, assignedTo: { $exists: false } }]
    : [{ assignedTo: null }, { assignedTo: { $exists: false } }];
  return { $or: [{ 'assignedTo.email': email }, ...availableCases] };
};

app.get('/api/official/complaints', officialRequired(async (req, res) => {
  const session = req.session || sessionFromRequest(req);
  const records = await complaints.find(officialComplaintScope(session?.email, session?.department, session?.role))
    .sort({ updatedAt: -1 })
    .limit(250)
    .toArray();
  return res.json(records);
}));

app.get('/api/official/profile', officialRequired(async (req, res) => {
  const session = req.session || sessionFromRequest(req);
  const profile = await users.findOne({ email: session?.email }) || {};
  return res.json({
    name: profile.name || session?.name || '',
    email: profile.email || session?.email || '',
    department: profile.department || session?.department || '',
    location: profile.location || '',
    coordinates: profile.coordinates || null,
    availableWorkers: Number.isFinite(Number(profile.availableWorkers)) ? Number(profile.availableWorkers) : null,
    resources: profile.resources || '',
  });
}));

app.patch('/api/official/profile/resources', officialRequired(async (req, res) => {
  const session = req.session || sessionFromRequest(req);
  const rawWorkers = req.body?.availableWorkers;
  const availableWorkers = rawWorkers === '' || rawWorkers === null || rawWorkers === undefined ? null : Number(rawWorkers);
  const resources = String(req.body?.resources || '').trim().slice(0, 1000);
  if (availableWorkers !== null && (!Number.isInteger(availableWorkers) || availableWorkers < 0 || availableWorkers > 100000)) {
    return res.status(400).json({ message: 'Available workers must be a whole number from 0 to 100000.' });
  }
  const result = await users.findOneAndUpdate(
    { email: session?.email, role: 'official' },
    { $set: { availableWorkers, resources, resourcesUpdatedAt: new Date() } },
    { returnDocument: 'after', projection: { name: 1, email: 1, department: 1, location: 1, coordinates: 1, availableWorkers: 1, resources: 1 } },
  );
  if (!result) return res.status(404).json({ message: 'Government official profile not found.' });
  return res.json({
    name: result.name || '', email: result.email || '', department: result.department || '', location: result.location || '', coordinates: result.coordinates || null,
    availableWorkers: Number.isFinite(Number(result.availableWorkers)) ? Number(result.availableWorkers) : null,
    resources: result.resources || '',
  });
}));

app.get('/api/official/intelligence', officialRequired(async (req, res) => {
  const session = req.session || sessionFromRequest(req);
  const records = await complaints.find(officialComplaintScope(session?.email, session?.department, session?.role))
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray();
  const profile = await users.findOne({ email: session?.email }) || {};
  return res.json(buildOfficialIntelligence(records, {
    department: profile.department || session?.department || '',
    availableWorkers: profile.availableWorkers,
    resources: profile.resources,
  }));
}));

app.post('/api/official/assistant', officialRequired(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ message: 'Ask the Government Official AI Assistance Agent a question.' });
  if (message.length > 1000) return res.status(400).json({ message: 'Please keep your question under 1,000 characters.' });
  const session = sessionFromRequest(req);
  const records = await complaints.find(officialComplaintScope(session?.email, session?.department, session?.role))
    .sort({ updatedAt: -1 })
    .limit(250)
    .toArray();
  const profile = await users.findOne({ email: session?.email }) || {};
  const intelligence = buildOfficialIntelligence(records, {
    department: profile.department || session?.department || '',
    availableWorkers: profile.availableWorkers,
    resources: profile.resources,
  });
  return res.json({
    reply: buildOfficialAssistantReply(message, records, intelligence),
    agent: {
      id: 'government-operations-assistance-agent',
      name: 'Government Operations AI Assistance Agent',
      role: 'official-facing-queue-agent',
      sources: ['visible official queue', 'case categories', 'locations', 'status and progress records'],
    },
    context: { visibleCaseCount: records.length, intelligenceGeneratedAt: intelligence.generatedAt },
  });
}));

app.post('/api/admin/assistant', adminRequired(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ message: 'Ask the Civic Administration AI Agent a question.' });
  if (message.length > 1000) return res.status(400).json({ message: 'Please keep your question under 1,000 characters.' });
  const records = await complaints.find({}).sort({ updatedAt: -1 }).limit(500).toArray();
  return res.json({
    reply: buildOfficialAssistantReply(message, records),
    agent: {
      id: 'civic-administration-assistance-agent',
      name: 'Civic Administration AI Agent',
      role: 'admin-facing-city-operations-agent',
      sources: ['all complaint records', 'department routing', 'status and progress records', 'location patterns'],
    },
    context: { visibleCaseCount: records.length },
  });
}));

app.post('/api/official/complaints/:id/claim', officialRequired(async (req, res) => {
  const session = sessionFromRequest(req);
  const now = new Date();
  const existing = await complaints.findOne({ id: req.params.id.toUpperCase() });
  if (!existing) return res.status(404).json({ message: 'Complaint not found.' });
  if (session.role !== 'admin' && session.department && existing.department !== session.department) {
    return res.status(403).json({ message: `This case belongs to the ${existing.department || 'responsible'} department.` });
  }
  const assignedTo = { email: session.email, name: session.name || session.email, department: session.department || '' };
  const result = await complaints.findOneAndUpdate(
    { id: req.params.id.toUpperCase(), $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] },
    {
      $set: { assignedTo, status: 'Assigned', updatedAt: now, 'agent.followUp.status': 'assigned', 'agent.followUp.lastActionAt': now, 'workOrder.status': 'assigned', 'workOrder.assignedTo': assignedTo, 'workOrder.updatedAt': now },
      $push: {
        timeline: {
          time: displayTime(now),
          title: 'Case Assigned',
          desc: `${assignedTo.name} claimed this complaint`,
          done: true,
          actor: session.email,
        },
      },
    },
    { returnDocument: 'after' },
  );
  if (result) return res.json(result);

  return res.status(409).json({ message: 'This complaint has already been assigned to another official.' });
}));

 app.patch('/api/official/complaints/:id/tasks/:taskId', officialRequired(async (req, res) => {
  const session = sessionFromRequest(req);
  const taskStatus = String(req.body?.status || '').trim();
  if (!['pending', 'in-progress', 'completed'].includes(taskStatus)) {
    return res.status(400).json({ message: 'Task status must be pending, in-progress, or completed.' });
  }
  const existing = await complaints.findOne({ id: req.params.id.toUpperCase() });
  if (!existing) return res.status(404).json({ message: 'Complaint not found.' });
  if (!existing.assignedTo && session.role !== 'admin') {
    return res.status(403).json({ message: 'Claim this complaint before updating work-order tasks.' });
  }
  if (existing.assignedTo?.email && existing.assignedTo.email !== session.email && session.role !== 'admin') {
    return res.status(403).json({ message: 'This complaint is assigned to another official.' });
  }
  if (!existing.workOrder?.tasks?.some(task => task.id === req.params.taskId)) {
    return res.status(404).json({ message: 'Work-order task not found.' });
  }
  const now = new Date();
  const result = await complaints.findOneAndUpdate(
    { _id: existing._id },
    {
      $set: {
        'workOrder.tasks.$[task].status': taskStatus,
        'workOrder.updatedAt': now,
        'workOrder.status': taskStatus === 'completed' ? 'in-progress' : taskStatus,
        updatedAt: now,
      },
      $push: {
        timeline: {
          time: displayTime(now),
          title: 'Work-order task updated',
          desc: `${req.params.taskId} marked ${taskStatus}.`,
          done: taskStatus === 'completed',
          actor: session.email,
        },
      },
    },
    { arrayFilters: [{ 'task.id': req.params.taskId }], returnDocument: 'after' },
  );
  const allCompleted = result.workOrder?.tasks?.length > 0 && result.workOrder.tasks.every(task => task.status === 'completed');
  if (allCompleted) {
    return res.json(await complaints.findOneAndUpdate(
      { _id: existing._id },
      { $set: { 'workOrder.status': 'completed', 'workOrder.completedAt': now, 'workOrder.updatedAt': now } },
      { returnDocument: 'after' },
    ));
  }
  return res.json(result);
 }));

app.post('/api/official/complaints/:id/replan', officialRequired(async (req, res) => {
  const session = sessionFromRequest(req);
  const existing = await complaints.findOne({ id: req.params.id.toUpperCase() });
  if (!existing) return res.status(404).json({ message: 'Complaint not found.' });
  if (existing.assignedTo?.email && existing.assignedTo.email !== session.email && session.role !== 'admin') {
    return res.status(403).json({ message: 'This complaint is assigned to another official.' });
  }

  const reason = String(req.body?.reason || 'Official requested an updated plan after reviewing the case.').trim().slice(0, 500);
  const cleanCategory = String(existing.category || '').trim();
  const cleanLocation = String(existing.location || '').trim();
  const duplicateCount = await findDuplicateCount({ category: cleanCategory, description: existing.description, location: cleanLocation, photoDataUrl: existing.photoDataUrl, excludeId: existing._id });
  const now = new Date();
   const agentRun = await enrichResponseAgent({ category: cleanCategory, description: existing.description, location: cleanLocation, photoDataUrl: existing.photoDataUrl }, buildResponseAgent({
    category: cleanCategory,
    description: existing.description,
    location: cleanLocation,
    urgency: existing.urgency,
    photoDataUrl: existing.photoDataUrl,
    coordinates: existing.reporter?.coordinates || null,
    createdAt: now,
  }, duplicateCount));
  const previousSnapshot = existing.agent ? {
    runId: existing.agent.runId,
    summary: existing.agent.summary,
    confidence: existing.agent.confidence,
    completedAt: existing.agent.completedAt,
  } : null;
  const agent = {
    ...agentRun.agent,
    replanReason: reason,
    previousRunId: existing.agent?.runId || null,
    history: [...(existing.agent?.history || []), ...(previousSnapshot ? [previousSnapshot] : [])].slice(-10),
    events: [...(existing.agent?.events || []), { type: 'replan', createdAt: now, reason }].slice(-20),
    followUp: { ...agentRun.agent.followUp, status: existing.status.toLowerCase().replace(/\s+/g, '-') },
  };
  const decision = agentRun.decision;
  const workOrder = buildWorkOrder(decision, agent.runId, {
    status: workOrderStatusFor(existing.status),
    assignedTo: existing.assignedTo || null,
    previousWorkOrderId: existing.workOrder?.id || null,
    now,
  });
  const result = await complaints.findOneAndUpdate(
    { _id: existing._id },
    {
      $set: {
        category: decision.category,
        department: decision.department,
        team: decision.team,
        urgency: decision.urgency,
        priority: decision.priority,
        impactScore: decision.impactScore,
        duplicates: decision.duplicateCount,
         eta: decision.eta,
         agentGeneratedDescription: decision.detailedDescription,
         agentOfficialBrief: decision.officialBrief,
          summary: decision.summary,
         agentDecision: decision,
         agent,
        workOrder,
        updatedAt: now,
      },
      $push: {
        timeline: {
          time: displayTime(now),
          title: 'Agent Re-plan',
          desc: `${reason} New route: ${decision.department}; next action: ${decision.nextAction}`,
          done: false,
          actor: session.email,
        },
      },
    },
    { returnDocument: 'after' },
  );
  return res.json(result);
}));

app.patch('/api/official/complaints/:id', officialRequired(async (req, res) => {
  const session = sessionFromRequest(req);
  const { status, note = '', resolutionPhotoDataUrl = '' } = req.body || {};
  const allowedStatuses = ['Received', 'Assigned', 'In Progress', 'Resolved', 'Escalated'];
  const cleanNote = String(note).trim();
  const photo = typeof resolutionPhotoDataUrl === 'string' ? resolutionPhotoDataUrl : '';

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: `Status must be one of: ${allowedStatuses.join(', ')}.` });
  }
  if (cleanNote.length > 2000) {
    return res.status(400).json({ message: 'Notes must be 2,000 characters or fewer.' });
  }
  if (photo.length > 5_000_000) {
    return res.status(413).json({ message: 'The resolution photo is too large. Please choose an image under 4 MB.' });
  }

  const existing = await complaints.findOne({ id: req.params.id.toUpperCase() });
  if (!existing) return res.status(404).json({ message: 'Complaint not found.' });
  if (existing.assignedTo?.email && existing.assignedTo.email !== session.email && session.role !== 'admin') {
    return res.status(403).json({ message: 'This complaint is assigned to another official.' });
  }

  const now = new Date();
  const assignedTo = existing.assignedTo || { email: session.email, name: session.name || session.email };
  const progressAnalysis = (existing.status !== status || cleanNote || photo)
    ? await analyzeOfficialUpdate({ complaint: existing, status, note: cleanNote, photoDataUrl: photo })
    : null;
  const update = {
    $set: { status, assignedTo, updatedAt: now, 'agent.followUp.status': status.toLowerCase().replace(/\s+/g, '-'), 'agent.followUp.lastActionAt': now, 'workOrder.status': workOrderStatusFor(status), 'workOrder.assignedTo': assignedTo, 'workOrder.updatedAt': now },
    $push: {},
  };
  const statusChanged = existing.status !== status;
  if (cleanNote) {
    update.$push.officialNotes = {
      text: cleanNote,
      author: { email: session.email, name: session.name || session.email },
      createdAt: now,
    };
  }
  if (photo) {
    update.$push.resolutionPhotos = {
      dataUrl: photo,
      uploadedBy: session.email,
      uploadedAt: now,
    };
  }
  if (progressAnalysis) {
    update.$set.progressPercent = progressAnalysis.progressPercent;
    update.$set.progressAnalysis = progressAnalysis;
    update.$set['agent.latestProgressAnalysis'] = progressAnalysis;
    update.$push.progressUpdates = {
      ...progressAnalysis,
      note: cleanNote,
      photoAttached: Boolean(photo),
      actor: session.email,
    };
  }
  if (statusChanged || cleanNote || photo) {
    update.$push.timeline = {
      time: displayTime(now),
      title: statusChanged ? status : 'Official Update',
      desc: cleanNote || (photo ? 'Resolution photo uploaded' : `Status updated to ${status}`),
      done: status === 'Resolved' ? true : status !== 'Received',
      actor: session.email,
    };
  } else {
    delete update.$push;
  }

  const result = await complaints.findOneAndUpdate(
    { _id: existing._id },
    update,
    { returnDocument: 'after' },
  );
  if (progressAnalysis) await notifyCitizen(result, status, progressAnalysis);
  return res.json(result);
}));

app.get('/api/complaints/:id', databaseRequired(async (req, res) => {
  const complaint = await complaints.findOne({ id: req.params.id.toUpperCase() });
  if (!complaint) return res.status(404).json({ message: 'Complaint not found.' });
  return res.json(complaint);
}));

app.get('/', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(frontendDirectory, 'index.html')));

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
  passwordResets = db.collection('passwordResets');
  officialRequests = db.collection('officialRequests');
  notifications = db.collection('notifications');
  await complaints.createIndex({ id: 1 }, { unique: true });
  await complaints.createIndex({ createdAt: -1 });
  await users.createIndex({ email: 1 }, { unique: true });
  await signupOtps.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await passwordResets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await officialRequests.createIndex({ requestId: 1 }, { unique: true });
  await officialRequests.createIndex({ status: 1, createdAt: -1 });
  await notifications.createIndex({ recipientEmail: 1, createdAt: -1 });
  await notifications.createIndex({ recipientIdentifier: 1, createdAt: -1 });
  await complaints.createIndex({ 'assignedTo.email': 1, status: 1, updatedAt: -1 });
  await ensureAdminAccount();
  app.listen(port, () => console.log(`CivicResolve running at http://localhost:${port}`));
  reviewDelayedComplaints().catch((error) => console.error('Initial agent follow-up review failed:', error.message));
  setInterval(() => reviewDelayedComplaints().catch((error) => console.error('Agent follow-up review failed:', error.message)), 5 * 60 * 1000);
}

start().catch((error) => {
  console.error('Unable to connect to MongoDB:', error.message);
  process.exitCode = 1;
});
