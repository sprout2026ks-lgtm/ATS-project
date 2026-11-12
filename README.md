# ATS Project

A Firebase-authenticated applicant tracking workspace built with React, Flask,
Firestore, and private Google Drive storage.

## Features

- Organize recruitment clients and their job requirements.
- Upload PDF and DOCX resumes individually or in batches. The interface splits
  larger selections into groups of eight; each file can be up to 15 MB.
- Extract selectable resume text and basic contact, experience, and skill fields
  on the backend. Image-only/scanned resumes need OCR and are not parsed yet.
- Keep original resumes in a private Drive folder and retrieve them through the
  authenticated API.
- Search candidates, display parsed candidate names and original resume
  filenames, hide contact details by default, and manage New, Reviewed,
  Shortlisted, Rejected, and Hired stages.
- Categorize clients and resumes as IT, Banking, Medical, or Other. Resume
  library uploads are placed in matching private Google Drive industry folders
  and can be filtered or reclassified by category in the ATS.
- Request explainable, job-related matching from OpenRouter. Candidate data is
  not sent until a recruiter starts an analysis. Email addresses, phone
  numbers, and the extracted candidate name are redacted before the request.
  The model is instructed to ignore protected traits; its score is advisory,
  and recruiters remain responsible for screening and shortlisting.
- Export a per-client recruitment pipeline summary as CSV.

## Configure Firebase and Firestore

1. Create a Firebase project and register a web app.
2. In **Authentication → Sign-in method**, enable **Email/Password** and
   **Phone**. Add the development and production domains to **Authorized
   domains**.
3. Configure the password-reset email template under **Authentication →
   Templates**, and create a Firestore database.
4. In `frontend`, copy `.env.example` to `.env` and set the Firebase web app
   values from **Project settings → Your apps**. These frontend values are
   public web-app configuration; never put service-account or AI credentials
   in the frontend.
5. In the repository root, copy `.env.example` to `.env`, set
   `FIREBASE_PROJECT_ID`, and set `CORS_ORIGINS` to the exact frontend origins.
   Give the backend Application Default Credentials permission to access
   Firestore and verify Firebase Authentication tokens, or set
   `FIREBASE_SERVICE_ACCOUNT_FILE` to a private service-account JSON file.
6. Configure Firestore rules so browser clients cannot read or write applicant
   records. The Flask API uses the Admin SDK and enforces per-user data paths;
   Admin SDK requests bypass Firestore rules.

## Configure Google Drive

1. Enable **Google Drive API** on the Google Cloud project set by
   `FIREBASE_PROJECT_ID`.
2. Grant the Drive account **Service Usage Consumer**
   (`roles/serviceusage.serviceUsageConsumer`) on that same project.
3. Sign in for backend Application Default Credentials as the Drive account:

   ```powershell
   gcloud auth application-default login --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive.file"
   ```

   The    backend creates private client folders and an `ATS Resumes` library in this
   account's Drive root. Resumes are grouped into IT, Banking, Medical, and
   Other subfolders. No pre-existing folder ID or folder sharing is required. If the backend
   runs under a different account or ADC location, set
   `GOOGLE_DRIVE_CREDENTIALS_FILE` to that account's local ADC credential file.

Using `drive.file`, the least-privilege Drive scope, avoids granting the app
access to all of the account's Drive. A pre-existing folder ID may not be
visible to this scope unless the user opened or selected it through the app;
the current frontend does not include a Drive Picker. If an old `.env` has
`GOOGLE_DRIVE_FOLDER_ID` configured, the backend ignores it and stores client
folders in the Drive credential account's root instead.

Keep local ADC credential files private. Never commit them or paste their
contents into an issue or chat. `FIREBASE_SERVICE_ACCOUNT_FILE` and
`GOOGLE_DRIVE_CREDENTIALS_FILE` are optional when the backend process already
has suitable ADC.

## Configure OpenRouter matching

Create an OpenRouter API key, then set the following only in the backend root
`.env`:

```dotenv
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=provider/model
```

Choose a model available to your OpenRouter account. Keep the key server-side;
do not use a `VITE_` variable. Review OpenRouter's privacy, retention, and model
provider settings before using real applicant information. Matching is disabled
if either setting is missing. Each explicit analysis request sends redacted
resume text and the selected job details to OpenRouter.

## Run locally

In one PowerShell terminal, from `backend`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m flask --app app run --host 127.0.0.1 --port 5051
```

In another terminal:

```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

Replace the example `VITE_FIREBASE_*` values in `frontend/.env` with your
Firebase web app settings, then restart Vite. Until configured, the sign-in
screen remains visible and shows a setup notice.

## Data model and API

All client, job, and applicant records are scoped to the authenticated user:

```text
users/{uid}/clients/{clientId}
users/{uid}/clients/{clientId}/jobRequirements/{jobId}
users/{uid}/clients/{clientId}/applicants/{applicantId}
```

Every ATS API endpoint requires a Firebase bearer token and a registered email
plus verified phone number. Resume text and Drive file IDs stay server-side;
candidate API responses mask contact details by default. Client records are
archived rather than deleted, preserving their associated recruitment history.
