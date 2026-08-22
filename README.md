# CivicResolve

AI Civic Complaint-to-Resolution Intelligence Platform.

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
