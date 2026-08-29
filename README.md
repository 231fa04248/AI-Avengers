# CivicResolve

AI Civic Complaint-to-Resolution Intelligence Platform.

## CivicResolve Response Agent

Complaint intake is powered by a Response Coordinator that delegates to six specialist agents:

- Intake Agent: classify and summarize the report.
- Memory Agent: find duplicate or nearby reports.
- Routing Agent: select the responsible department and team.
- Priority Agent: score impact, urgency and risk.
- Follow-up Agent: monitor deadlines and trigger escalation.
- Explanation Agent: prepare citizen and official-facing reasoning.

The coordinator manages the full prototype workflow:

1. Understands the category and report text, or starts a visual triage from a citizen photo and provided location.
2. Summarizes text and records text, image and citizen-provided location signals.
3. Checks MongoDB for similar complaints at the same location.
4. Decides urgency, impact score, department and response team.
5. Schedules follow-up and automatically escalates delayed open cases.
6. Explains the decision to citizens and officials with a trace, risk flags and next action.
7. Finds recurring location/category patterns and recommends permanent interventions.

The agent is available through `POST /api/agent/preview`, `GET /api/agent/insights` and `GET /api/agent/escalations` for authorized officials. An official can also call `POST /api/official/complaints/:id/replan` from the dashboard when new information arrives; the previous plan is retained in the case history. The agent also runs automatically when a complaint is submitted. Its trace is stored on the complaint as `agent`, so citizens, officials and hackathon judges can see why the case was routed. It uses the local policy agent by default, so no paid model key is required for the demo.

For an optional generative reasoning layer, install and run Ollama locally, pull the configured model, and set `AGENT_LLM_ENABLED=true` in `.env`. The model enriches summaries, citizen explanations and recommended actions; classification, routing, priority and escalation remain protected by the policy workflow. If Ollama is unavailable, the agent automatically falls back to the local policy output.

For photo-only semantic classification, use a vision-capable Ollama model such as `gemma3:4b` (the smaller `gemma3:1b` model is text-only). The upload is still accepted without the model, but the case remains `Other` and is marked for official visual verification until a vision model is enabled.

Each submitted case also receives an agent-created work order with a due time and task checklist. Authorized officials can update tasks through `PATCH /api/official/complaints/:id/tasks/:taskId`; completing all tasks marks the work order complete, while the complaint still requires an official resolution decision.

## Hackathon demo story

Use a high-risk example such as: “An overflowing drain has flooded the road beside a school for two days.” Run agent triage to show classification, duplicate memory, Water and Drainage routing, Critical priority, risk flags, six specialist agents and the human-approval decision. Submit the case, switch to the official dashboard, claim it, then use **Ask agent to re-plan** with new information. Finish on City Analytics to show recurring-problem intelligence and permanent-fix recommendations.

## Project structure

```text
frontend/    CivicResolve web interface
backend/     Express API, MongoDB, authentication, OTP and admin workflows
.env         Local configuration (not committed)
```

## Run locally

1. Make sure MongoDB is running.
2. Create `.env` from `.env.example` and fill in the local values.
3. Install backend dependencies:

   ```powershell
   cd backend
   npm install
   ```

4. Start the application:

   ```powershell
   npm start
   ```

5. Open <http://localhost:5000>.

The backend serves the frontend, so a separate frontend terminal is not required.

## Deploy on Render

This repository includes `render.yaml` for deploying the backend and frontend as one web service.

1. Create a MongoDB Atlas database and allow the deployed service to connect to it.
2. Push this repository to GitHub.
3. In Render, choose **New + → Blueprint**, select the repository, and apply `render.yaml`.
4. Enter the requested secret values: `MONGODB_URI`, `SMTP_USER`, `SMTP_PASS`, `OTP_FROM`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
5. After deployment, open the generated `onrender.com` URL. Render supplies the production `PORT` automatically.

The hosted default uses the local policy agent. Do not set `OLLAMA_URL` to `127.0.0.1` in production; a local Ollama process is not reachable from Render. Use a hosted vision provider later if production photo understanding is required.
