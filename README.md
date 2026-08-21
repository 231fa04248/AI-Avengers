# CivicAI

CivicAI is a civic-tech platform that turns citizen reports into actionable, transparent work for municipal teams. It combines structured complaint workflows, explainable prioritization, duplicate detection, department routing, deadline automation, escalations, and role-specific dashboards.

## What is included

- Citizen, admin, department officer, and field worker experiences.
- JWT authentication with bcrypt password hashing and role-based authorization.
- Multi-image complaint submission, location capture, transparent timelines, and notifications.
- AI analysis pipeline with an external FastAPI service, Sentence Transformers duplicate detection, and an optional LLM provider.
- Priority scoring using severity, urgency, safety risk, and impact.
- Automatic deadlines and three-level overdue escalation with deduplication.
- Admin analytics, recurring problem detection, department performance, and location views.
- Seed data and demo credentials for a quick local walkthrough.

## Architecture

```text
React + Vite + Tailwind + Leaflet
              |
        Express REST API
              |
           MongoDB
              |
      FastAPI AI service
       /              \
LLM abstraction   Sentence Transformers
```

## Technology stack

Client: React, Vite, React Router, Tailwind CSS, Lucide React, Axios, React Hook Form, Recharts, Leaflet.

Server: Node.js, Express, MongoDB, Mongoose, JWT, bcryptjs, Multer, node-cron, dotenv, CORS.

AI service: FastAPI, Pydantic, Sentence Transformers, scikit-learn, optional OpenCV-compatible upload handling.

## Project structure

```text
client/       React application
server/       Express API, models, jobs, seed data
ai-service/   FastAPI analysis and duplicate detection service
uploads/      Local development upload directory
```

## Local installation

Requirements: Node.js 20+, Python 3.10+, and MongoDB 6+ running locally or a MongoDB Atlas URI.

```powershell
npm run install:all
python -m venv ai-service/.venv
ai-service/.venv/Scripts/pip install -r ai-service/requirements.txt
Copy-Item server/.env.example server/.env
Copy-Item ai-service/.env.example ai-service/.env
```

Set `LLM_API_KEY` only if an OpenAI-compatible provider should be used. The application has a deterministic local fallback when no key or service is available.

## Run the platform

Start MongoDB, then use three terminals:

```powershell
# Terminal 1
python -m uvicorn main:app --reload --port 8000 --app-dir ai-service

# Terminal 2
npm run dev --prefix server

# Terminal 3
npm run dev --prefix client
```

The client is available at `http://localhost:5173`, the API at `http://localhost:5000/api`, and the AI service at `http://localhost:8000`.

Seed a local database:

```powershell
npm run seed
```

## Demo credentials

All demo accounts use password `CivicAI@2026` after seeding.

| Role | Email |
| --- | --- |
| Admin | admin@civicai.local |
| Citizen | citizen@civicai.local |
| Department officer | roads.officer@civicai.local |
| Field worker | field.worker@civicai.local |

## Environment variables

See [server/.env.example](server/.env.example) and [ai-service/.env.example](ai-service/.env.example). Never commit real secrets. The server accepts any OpenAI-compatible chat endpoint through `LLM_BASE_URL` and `LLM_MODEL`.

## API overview

Authentication: `/api/auth/register`, `/api/auth/login`, `/api/auth/profile`.

Complaints: `/api/complaints`, `/api/complaints/:id`, `/api/complaints/:id/assign`, `/status`, `/resolve`, `/close`, `/reopen`, and `/timeline`.

Operations: `/api/departments`, `/api/teams`, `/api/notifications`.

Analytics: `/api/analytics/overview`, `/category`, `/priority`, `/status`, `/department`, `/recurring`, and `/locations`.

AI service: `POST /analyze`, `POST /classify`, `POST /duplicate-check`, `POST /priority`, and `POST /route`.

## Testing

```powershell
npm test
```

The server test suite covers scoring utilities, deadline rules, authorization middleware, and escalation de-duplication behavior without requiring a running database.

## Future enhancements

Production object storage, push notifications, ward-level GIS layers, multilingual speech-to-text intake, model evaluation dashboards, and integrations with municipal work-order systems.


