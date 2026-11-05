# ATS Project authentication

React and Firebase Authentication provide email/password sign-in, verified SMS
phone sign-in, and email password-reset links. Flask verifies Firebase ID tokens
and stores user profiles in Firestore. Passwords and SMS verification codes are
handled by Firebase and are never sent to the Flask API.

## Configure Firebase

1. Create a Firebase project and register a web app.
2. In **Authentication → Sign-in method**, enable **Email/Password** and
   **Phone**. Add the development and production domains to **Authorized
   domains**.
3. Configure the password-reset email template under **Authentication →
   Templates**. Firebase's secure action page lets a recipient choose a new
   password from the email link.
4. Create a Firestore database.
5. In `frontend`, copy `.env.example` to `.env` and set the Firebase web app
   values from **Project settings → Your apps**. Keep the Firebase API key in
   its intended public web-app role; never put service-account credentials in
   the frontend.
6. In the repository root, copy `.env.example` to `.env` and set the Firebase
   project ID and set `CORS_ORIGINS` to the exact comma-separated frontend
   origins you use. Flask loads this file automatically. Give the Flask process
   Application Default Credentials with permission to access Firestore and
   verify Firebase Authentication tokens.
   For local development, sign in with `gcloud auth application-default login`
   and set `GOOGLE_CLOUD_PROJECT` if your ADC setup requires it. Do not commit
   service-account key files.

Phone numbers must include their country code (for example, `+15551234567`).
Firebase requires reCAPTCHA verification and may require SMS billing or a
configured SMS region policy. Use Firebase's fictional phone numbers while
developing to avoid sending real SMS messages.

## Run locally

In one terminal, from `backend`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m flask --app app run --host 127.0.0.1 --port 5050
```

In another terminal:

```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

Replace the example `VITE_FIREBASE_*` values in `frontend/.env` with the values
from your Firebase web app, then restart Vite. Until configured, the sign-in
screen remains visible and shows a setup notice; authentication buttons are
disabled.

The frontend calls `POST /api/profile` after registration or sign-in. Flask
verifies the bearer token against Firebase, then creates or updates
`users/{uid}` in Firestore. The API is intentionally not an email/password
authentication endpoint; Firebase Authentication owns credential handling,
email reset links, and SMS one-time codes.
