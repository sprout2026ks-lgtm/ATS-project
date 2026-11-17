import io
import json
import os
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from backend.app import (
    create_app,
    extract_candidate_fields,
    extract_resume_text,
    redact_resume_text,
)


AUTH_HEADERS = {"Authorization": "Bearer test-token"}
VERIFIED_CLAIMS = {
    "uid": "user-1",
    "email": "recruiter@example.com",
    "phone_number": "+15551234567",
}


class AtsApiTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(
            os.environ,
            {
                "FIREBASE_PROJECT_ID": "test-project",
                "FIREBASE_SERVICE_ACCOUNT_FILE": "",
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

        self.firebase_get_app = patch(
            "backend.app.firebase_admin.get_app", side_effect=ValueError
        )
        self.firebase_get_app.start()
        self.addCleanup(self.firebase_get_app.stop)
        self.firebase_initialize = patch("backend.app.firebase_admin.initialize_app")
        self.firebase_initialize_mock = self.firebase_initialize.start()
        self.addCleanup(self.firebase_initialize.stop)
        self.database = Mock()
        self.firestore_client = patch(
            "backend.app.firestore.client", return_value=self.database
        )
        self.firestore_client.start()
        self.addCleanup(self.firestore_client.stop)

        self.app = create_app()
        self.client = self.app.test_client()

    def user_client_reference(self):
        return (
            self.database.collection.return_value.document.return_value
            .collection.return_value.document.return_value
        )

    def test_clients_require_authentication(self):
        response = self.client.get("/api/clients")

        self.assertEqual(response.status_code, 401)
        self.database.collection.assert_not_called()

    def test_firebase_service_account_file_is_used_for_initialization(self):
        credential = object()
        credential_file = "credentials/test-firebase.json"
        self.firebase_initialize_mock.reset_mock()
        with patch.dict(
            os.environ,
            {"FIREBASE_SERVICE_ACCOUNT_FILE": credential_file},
        ):
            with patch(
                "backend.app.credentials.Certificate",
                return_value=credential,
            ) as certificate:
                create_app()

        certificate.assert_called_once_with(
            str(Path(__file__).resolve().parent.parent / credential_file)
        )
        self.firebase_initialize_mock.assert_called_once_with(
            credential=credential,
            options={"projectId": "test-project"},
        )

    def test_client_creation_is_scoped_to_the_verified_user(self):
        reference = self.user_client_reference()
        snapshot = Mock()
        snapshot.id = "client-1"
        snapshot.to_dict.return_value = {"organizationName": "Acme"}
        reference.get.return_value = snapshot
        with patch("backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS):
            response = self.client.post(
                "/api/clients",
                headers=AUTH_HEADERS,
                json={"organizationName": " Acme "},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["client"]["id"], "client-1")
        self.assertEqual(response.json["client"]["organizationName"], "Acme")
        self.database.collection.assert_called_once_with("users")
        reference.set.assert_called_once()

    def test_client_delete_cascades_and_preserves_library_resume(self):
        user_reference = self.database.collection.return_value.document.return_value
        clients = Mock()
        resumes = Mock()
        client_reference = Mock()
        user_reference.collection.side_effect = lambda name: {
            "clients": clients,
            "resumes": resumes,
        }[name]
        clients.document.return_value = client_reference
        client_snapshot = Mock()
        client_snapshot.exists = True
        client_snapshot.to_dict.return_value = {"driveFolderId": "client-folder"}
        client_reference.get.return_value = client_snapshot

        applicant_collection = Mock()
        jobs_collection = Mock()
        client_reference.collection.side_effect = lambda name: {
            "applicants": applicant_collection,
            "jobRequirements": jobs_collection,
        }[name]
        applicant_reference = Mock()
        applicant_snapshot = Mock()
        applicant_snapshot.reference = applicant_reference
        applicant_snapshot.to_dict.return_value = {
            "libraryResumeId": "library-resume-1",
        }
        applicant_collection.stream.return_value = [applicant_snapshot]
        job_reference = Mock()
        job_snapshot = Mock()
        job_snapshot.id = "job-1"
        job_snapshot.reference = job_reference
        jobs_collection.stream.return_value = [job_snapshot]

        resume_reference = Mock()
        resume_snapshot = Mock()
        resume_snapshot.id = "library-resume-1"
        resume_snapshot.reference = resume_reference
        resume_snapshot.to_dict.return_value = {
            "sourceClientId": "client-1",
            "sourceApplicantId": "candidate-1",
        }
        resumes.stream.return_value = [resume_snapshot]
        resumes.document.return_value = resume_reference
        resume_match = resume_reference.collection.return_value.document.return_value
        drive = Mock()
        drive.files.return_value.list.return_value.execute.return_value = {"files": []}

        with patch.dict(
            os.environ,
            {"GOOGLE_DRIVE_CREDENTIALS_FILE": "credentials/drive-user.json"},
        ), patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.load_credentials_from_file",
            return_value=(Mock(), "test-project"),
        ), patch("backend.app.build", return_value=drive):
            response = self.client.delete(
                "/api/clients/client-1",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 200)
        applicant_reference.delete.assert_called_once()
        job_reference.delete.assert_called_once()
        client_reference.delete.assert_called_once()
        resume_match.delete.assert_called_once()
        resume_reference.update.assert_called_once()
        resume_reference.delete.assert_not_called()
        drive.files.return_value.delete.assert_called_once_with(
            fileId="client-folder"
        )

    def test_job_delete_removes_its_saved_assessment_and_match(self):
        user_reference = self.database.collection.return_value.document.return_value
        clients = Mock()
        resumes = Mock()
        client_reference = Mock()
        user_reference.collection.side_effect = lambda name: {
            "clients": clients,
            "resumes": resumes,
        }[name]
        clients.document.return_value = client_reference
        client_reference.get.return_value.exists = True

        jobs = Mock()
        applicants = Mock()
        client_reference.collection.side_effect = lambda name: {
            "jobRequirements": jobs,
            "applicants": applicants,
        }[name]
        job_reference = Mock()
        job_reference.get.return_value.exists = True
        jobs.document.return_value = job_reference
        applicant_reference = Mock()
        applicant = Mock()
        applicant.reference = applicant_reference
        applicant.to_dict.return_value = {"analyzedJobId": "job-1", "matchScore": 82}
        applicants.stream.return_value = [applicant]

        resume_reference = Mock()
        resume = Mock()
        resume.id = "resume-1"
        resumes.stream.return_value = [resume]
        resumes.document.return_value = resume_reference
        match_reference = resume_reference.collection.return_value.document.return_value

        with patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ):
            response = self.client.delete(
                "/api/clients/client-1/jobs/job-1",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 200)
        applicant_reference.update.assert_called_once()
        job_reference.delete.assert_called_once()
        match_reference.delete.assert_called_once()

    def test_candidate_delete_removes_client_drive_file(self):
        client_reference = self.user_client_reference()
        applicant_collection = Mock()
        applicant_reference = Mock()
        applicant_snapshot = Mock()
        applicant_snapshot.exists = True
        applicant_snapshot.to_dict.return_value = {"driveFileId": "candidate-file"}
        applicant_reference.get.return_value = applicant_snapshot
        client_reference.collection.return_value = applicant_collection
        applicant_collection.document.return_value = applicant_reference
        drive = Mock()

        with patch.dict(
            os.environ,
            {"GOOGLE_DRIVE_CREDENTIALS_FILE": "credentials/drive-user.json"},
        ), patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.load_credentials_from_file",
            return_value=(Mock(), "test-project"),
        ), patch("backend.app.build", return_value=drive):
            response = self.client.delete(
                "/api/clients/client-1/applicants/candidate-1",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 200)
        drive.files.return_value.delete.assert_called_once_with(
            fileId="candidate-file"
        )
        applicant_reference.delete.assert_called_once()

    def test_library_resume_delete_removes_file_and_record(self):
        user_reference = self.database.collection.return_value.document.return_value
        resume_reference = user_reference.collection.return_value.document.return_value
        resume_snapshot = Mock()
        resume_snapshot.exists = True
        resume_snapshot.to_dict.return_value = {"driveFileId": "library-file"}
        resume_reference.get.return_value = resume_snapshot
        resume_reference.collection.return_value.stream.return_value = []
        drive = Mock()

        with patch.dict(
            os.environ,
            {"GOOGLE_DRIVE_CREDENTIALS_FILE": "credentials/drive-user.json"},
        ), patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.load_credentials_from_file",
            return_value=(Mock(), "test-project"),
        ), patch("backend.app.build", return_value=drive):
            response = self.client.delete(
                "/api/resumes/resume-1",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 200)
        drive.files.return_value.delete.assert_called_once_with(fileId="library-file")
        resume_reference.delete.assert_called_once()

    def test_applicant_list_shows_resume_names_and_masks_contact_details(self):
        reference = self.user_client_reference()
        client_snapshot = Mock()
        client_snapshot.exists = True
        reference.get.return_value = client_snapshot
        applicant = Mock()
        applicant.id = "candidate-123"
        applicant.to_dict.return_value = {
            "candidateName": "Ada Lovelace",
            "email": "ada@example.com",
            "contactNumber": "+15551234567",
            "resumeFileName": "Ada-Lovelace-resume.pdf",
            "location": "London",
            "comments": "Speak with Ada",
            "driveFileId": "private-drive-id",
            "extractedText": "private resume text\nProfessional Experience: 5+ years",
            "skills": ["Python"],
            "totalExperience": 0,
            "status": "New",
        }
        reference.collection.return_value.limit.return_value.stream.return_value = [
            applicant
        ]
        with patch("backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS):
            response = self.client.get(
                "/api/clients/client-1/applicants",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 200)
        candidate = response.json["applicants"][0]
        self.assertEqual(candidate["candidateName"], "Ada Lovelace")
        self.assertEqual(candidate["email"], "")
        self.assertEqual(candidate["contactNumber"], "")
        self.assertEqual(candidate["resumeFileName"], "Ada-Lovelace-resume.pdf")
        self.assertEqual(candidate["location"], "")
        self.assertEqual(candidate["totalExperience"], 5)
        self.assertEqual(candidate["comments"], "")
        self.assertNotIn("driveFileId", candidate)
        self.assertNotIn("extractedText", candidate)

    def test_job_creation_saves_optional_location(self):
        reference = self.user_client_reference()
        client_snapshot = Mock()
        client_snapshot.exists = True
        reference.get.return_value = client_snapshot
        job_reference = reference.collection.return_value.document.return_value
        job_reference.id = "job-1"
        job_reference.get.return_value.to_dict.return_value = {
            "title": "Engineer",
            "location": "London",
            "minimumExperience": 0,
        }
        with patch("backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS):
            response = self.client.post(
                "/api/clients/client-1/jobs",
                headers=AUTH_HEADERS,
                json={"title": " Engineer ", "location": " London "},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["job"]["location"], "London")
        saved_job = job_reference.set.call_args.args[0]
        self.assertEqual(saved_job["location"], "London")

    def test_pdf_resume_text_is_extracted(self):
        import fitz

        document = fitz.open()
        page = document.new_page()
        page.insert_text((72, 72), "Ada Lovelace Python")
        content = document.tobytes()
        document.close()

        self.assertEqual(
            extract_resume_text("resume.pdf", content),
            "Ada Lovelace Python\n",
        )

    def test_docx_resume_text_and_candidate_fields_are_extracted(self):
        document = io.BytesIO()
        with zipfile.ZipFile(document, "w") as archive:
            archive.writestr(
                "word/document.xml",
                (
                    '<w:document xmlns:w="http://schemas.openxmlformats.org/'
                    'wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
                    "Ada Lovelace ada@example.com +1 555 123 4567 "
                    "Python SQL 5 years of experience"
                    "</w:t></w:r></w:p></w:body></w:document>"
                ),
            )
        text = extract_resume_text("resume.docx", document.getvalue())
        fields = extract_candidate_fields(text, "Candidate 123456")

        self.assertIn("Python", text)
        self.assertEqual(fields["candidateName"], "Ada Lovelace")
        self.assertEqual(fields["email"], "ada@example.com")
        self.assertEqual(fields["totalExperience"], 5)
        self.assertIn("python", fields["skills"])

    def test_candidate_experience_is_none_when_not_detected(self):
        fields = extract_candidate_fields("Ada Lovelace\nPython", "Candidate 123456")

        self.assertIsNone(fields["totalExperience"])

    def test_candidate_experience_parses_common_resume_formats(self):
        examples = (
            ("Professional Experience: 5+ years", 5),
            ("Total Experience: 3 years and 6 months", 3.5),
            ("2 yrs of professional experience", 2),
            ("4 years of experience", 4),
        )
        for resume_text, expected in examples:
            with self.subTest(resume_text=resume_text):
                fields = extract_candidate_fields(resume_text, "Candidate")
                self.assertEqual(fields["totalExperience"], expected)

    def test_openrouter_request_redacts_resume_contact_details(self):
        client_reference = self.user_client_reference()
        applicant_reference = Mock()
        job_reference = Mock()
        applicant_collection = Mock()
        applicant_collection.document.return_value = applicant_reference
        job_collection = Mock()
        job_collection.document.return_value = job_reference
        client_reference.collection.side_effect = lambda name: {
            "applicants": applicant_collection,
            "jobRequirements": job_collection,
        }[name]

        applicant_snapshot = Mock()
        applicant_snapshot.exists = True
        applicant_snapshot.to_dict.return_value = {
            "candidateName": "Ada Lovelace",
            "extractedText": "Ada Lovelace ada@example.com +1 555 123 4567 Python SQL",
        }
        applicant_reference.get.return_value = applicant_snapshot
        job_snapshot = Mock()
        job_snapshot.exists = True
        job_snapshot.to_dict.return_value = {
            "title": "Engineer",
            "description": "Build software",
            "requiredSkills": ["Python"],
            "preferredSkills": ["SQL"],
            "minimumExperience": 2,
        }
        job_reference.get.return_value = job_snapshot

        provider_response = MagicMock()
        provider_response.__enter__.return_value = provider_response
        provider_response.read.return_value = json.dumps({
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "matchScore": 86,
                        "rationale": "Strong skill match.",
                        "matchedSkills": ["Python"],
                        "missingSkills": [],
                    })
                }
            }]
        }).encode("utf-8")
        with patch.dict(
            os.environ,
            {"OPENROUTER_API_KEY": "test-key", "OPENROUTER_MODEL": "provider/model"},
        ), patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.urllib.request.urlopen", return_value=provider_response
        ) as openrouter:
            response = self.client.post(
                "/api/clients/client-1/applicants/candidate-1/analyze",
                headers=AUTH_HEADERS,
                json={"jobId": "job-1"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["assessment"]["matchScore"], 86)
        self.assertTrue(response.json["assessment"]["recommended"])
        request_body = json.loads(openrouter.call_args.args[0].data)
        sent_prompt = json.loads(request_body["messages"][1]["content"])
        self.assertNotIn("ada@example.com", sent_prompt["resume"])
        self.assertNotIn("Ada Lovelace", sent_prompt["resume"])
        self.assertNotIn("+1 555 123 4567", sent_prompt["resume"])
        self.assertIn("Python", sent_prompt["resume"])
        applicant_reference.update.assert_called_once()

    def test_upload_stores_original_in_industry_folder_and_shows_resume_names(self):
        client_reference = self.user_client_reference()
        client_snapshot = Mock()
        client_snapshot.exists = True
        client_snapshot.to_dict.return_value = {"organizationName": "Acme"}
        client_reference.get.return_value = client_snapshot
        applicant_reference = Mock()
        applicant_reference.id = "candidate-123"
        client_reference.collection.return_value.document.return_value = applicant_reference
        drive = Mock()
        drive.files.return_value.list.return_value.execute.return_value = {"files": []}
        drive.files.return_value.create.return_value.execute.side_effect = [
            {"id": "client-folder"},
            {"id": "industry-folder"},
            {"id": "private-resume"},
        ]
        document = io.BytesIO()
        with zipfile.ZipFile(document, "w") as archive:
            archive.writestr(
                "word/document.xml",
                (
                    '<w:document xmlns:w="http://schemas.openxmlformats.org/'
                    'wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
                    "Ada Lovelace ada@example.com Python"
                    "</w:t></w:r></w:p></w:body></w:document>"
                ),
            )
        with patch.dict(
            os.environ,
            {
                "GOOGLE_DRIVE_FOLDER_ID": "private-root",
                "GOOGLE_DRIVE_CREDENTIALS_FILE": "credentials/drive-user.json",
            },
        ), patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.load_credentials_from_file",
            return_value=(Mock(), "test-project"),
        ), patch(
            "backend.app.build", return_value=drive
        ):
            response = self.client.post(
                "/api/clients/client-1/applicants",
                headers=AUTH_HEADERS,
                data={"files": (io.BytesIO(document.getvalue()), "ada-resume.docx")},
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["uploaded"][0]["candidateName"], "Ada Lovelace")
        self.assertEqual(response.json["uploaded"][0]["resumeFileName"], "ada-resume.docx")
        self.assertEqual(response.json["uploaded"][0]["industry"], "Other")
        self.assertEqual(drive.files.return_value.create.call_count, 3)
        applicant_reference.set.assert_called_once()
        saved = applicant_reference.set.call_args.args[0]
        self.assertEqual(saved["driveFileId"], "private-resume")
        self.assertEqual(saved["candidateName"], "Ada Lovelace")
        self.assertEqual(saved["industry"], "Other")
        upload_file = drive.files.return_value.create.call_args_list[2]
        self.assertEqual(upload_file.kwargs["body"]["parents"], ["industry-folder"])

    def test_library_upload_stores_original_in_private_drive_folder(self):
        user_reference = self.database.collection.return_value.document.return_value
        user_reference.get.return_value.to_dict.return_value = {}
        resume_reference = (
            user_reference.collection.return_value.document.return_value
        )
        resume_reference.id = "resume-123456"
        drive = Mock()
        drive.files.return_value.list.return_value.execute.return_value = {"files": []}
        drive.files.return_value.create.return_value.execute.side_effect = [
            {"id": "resume-folder"},
            {"id": "industry-folder"},
            {"id": "private-resume"},
        ]
        document = io.BytesIO()
        with zipfile.ZipFile(document, "w") as archive:
            archive.writestr(
                "word/document.xml",
                (
                    '<w:document xmlns:w="http://schemas.openxmlformats.org/'
                    'wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
                    "Ada Lovelace ada@example.com Python"
                    "</w:t></w:r></w:p></w:body></w:document>"
                ),
            )
        with patch.dict(
            os.environ,
            {"GOOGLE_DRIVE_CREDENTIALS_FILE": "credentials/drive-user.json"},
        ), patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.load_credentials_from_file",
            return_value=(Mock(), "test-project"),
        ), patch(
            "backend.app.build", return_value=drive
        ):
            response = self.client.post(
                "/api/resumes",
                headers=AUTH_HEADERS,
                data={
                    "industry": "Banking",
                    "files": (io.BytesIO(document.getvalue()), "ada-resume.docx"),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["uploaded"][0]["candidateName"], "Ada Lovelace")
        self.assertEqual(response.json["uploaded"][0]["resumeFileName"], "ada-resume.docx")
        self.assertEqual(response.json["uploaded"][0]["industry"], "Banking")
        self.assertEqual(drive.files.return_value.create.call_count, 3)
        uploaded_file = drive.files.return_value.create.call_args_list[2]
        self.assertEqual(uploaded_file.kwargs["body"]["parents"], ["industry-folder"])
        resume_reference.set.assert_called_once()
        saved = resume_reference.set.call_args.args[0]
        self.assertEqual(saved["driveFileId"], "private-resume")
        self.assertEqual(saved["candidateName"], "Ada Lovelace")
        self.assertEqual(saved["industry"], "Banking")

    def test_candidate_can_be_copied_to_resume_library_only_once(self):
        client_reference = self.user_client_reference()
        applicant_reference = Mock()
        applicant_snapshot = Mock()
        applicant_snapshot.exists = True
        applicant_snapshot.to_dict.return_value = {
            "candidateName": "Aparna M",
            "email": "aparna@example.com",
            "contactNumber": "1234567890",
            "resumeFileName": "Aparna_Profile.pdf",
            "industry": "Other",
            "driveFileId": "client-resume-file",
            "extractedText": "Aparna M Python",
            "skills": ["python"],
            "totalExperience": 5,
            "status": "New",
        }
        applicant_reference.get.return_value = applicant_snapshot
        client_reference.collection.return_value.document.return_value = applicant_reference

        user_reference = self.database.collection.return_value.document.return_value
        user_reference.get.return_value.to_dict.return_value = {
            "resumeDriveFolderId": "resume-root",
        }
        resume_reference = user_reference.collection.return_value.document.return_value
        resume_reference.id = "library-resume-1"
        resume_snapshot = Mock()
        resume_snapshot.exists = True
        resume_reference.get.return_value = resume_snapshot
        drive = Mock()
        drive.files.return_value.list.return_value.execute.return_value = {"files": []}
        drive.files.return_value.create.return_value.execute.return_value = {
            "id": "industry-folder",
        }
        drive.files.return_value.copy.return_value.execute.return_value = {
            "id": "library-copy-file",
        }

        with patch.dict(
            os.environ,
            {"GOOGLE_DRIVE_CREDENTIALS_FILE": "credentials/drive-user.json"},
        ), patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.load_credentials_from_file",
            return_value=(Mock(), "test-project"),
        ), patch(
            "backend.app.build", return_value=drive
        ):
            response = self.client.post(
                "/api/clients/client-1/applicants/candidate-1/library",
                headers=AUTH_HEADERS,
            )
            applicant_snapshot.to_dict.return_value["libraryResumeId"] = "library-resume-1"
            duplicate_response = self.client.post(
                "/api/clients/client-1/applicants/candidate-1/library",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["resume"]["id"], "library-resume-1")
        self.assertFalse(response.json["alreadyExists"])
        self.assertEqual(duplicate_response.status_code, 200)
        self.assertTrue(duplicate_response.json["alreadyExists"])
        self.assertEqual(drive.files.return_value.copy.call_count, 1)
        self.assertEqual(
            drive.files.return_value.copy.call_args.kwargs["body"]["parents"],
            ["industry-folder"],
        )
        resume_reference.set.assert_called_once()
        saved = resume_reference.set.call_args.args[0]
        self.assertEqual(saved["driveFileId"], "library-copy-file")
        self.assertEqual(saved["candidateName"], "Aparna M")
        self.assertEqual(saved["sourceClientId"], "client-1")
        applicant_reference.update.assert_called_once()

    def test_resume_listing_filters_by_industry_and_hides_contact_details(self):
        user_reference = self.database.collection.return_value.document.return_value
        resume = Mock()
        resume.id = "resume-123456"
        resume.to_dict.return_value = {
            "candidateName": "Ada Lovelace",
            "resumeFileName": "ada-resume.docx",
            "industry": "Medical",
            "email": "ada@example.com",
            "contactNumber": "+15551234567",
        }
        user_reference.collection.return_value.limit.return_value.stream.return_value = [
            resume
        ]
        with patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ):
            response = self.client.get(
                "/api/resumes?industry=Medical",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json["resumes"]), 1)
        result = response.json["resumes"][0]
        self.assertEqual(result["candidateName"], "Ada Lovelace")
        self.assertEqual(result["resumeFileName"], "ada-resume.docx")
        self.assertEqual(result["industry"], "Medical")
        self.assertEqual(result["email"], "")
        self.assertEqual(result["contactNumber"], "")

    def test_resume_listing_attaches_saved_match_by_resume_reference(self):
        user_reference = self.database.collection.return_value.document.return_value
        clients = Mock()
        resumes = Mock()
        client_reference = Mock()
        job_reference = Mock()
        user_reference.collection.side_effect = lambda name: {
            "clients": clients,
            "resumes": resumes,
        }[name]
        clients.document.return_value = client_reference
        client_reference.get.return_value.exists = True
        client_reference.collection.return_value.document.return_value = job_reference
        job_reference.get.return_value.exists = True

        resume = Mock()
        resume.id = "resume-123456"
        resume.to_dict.return_value = {
            "candidateName": "Ada Lovelace",
            "resumeFileName": "ada-resume.docx",
            "industry": "IT",
        }
        resumes.limit.return_value.stream.return_value = [resume]
        resume_reference = Mock()
        resumes.document.return_value = resume_reference
        match_reference = Mock()
        match_reference.path = "users/user-1/resumes/resume-123456/matches/match-hash"
        resume_reference.collection.return_value.document.return_value = match_reference
        match_snapshot = Mock()
        match_snapshot.id = "match-hash"
        match_snapshot.reference = match_reference
        match_snapshot.exists = True
        match_snapshot.to_dict.return_value = {
            "matchScore": 91,
            "matchRationale": "Strong role fit.",
            "recommended": True,
            "clientId": "client-1",
            "jobId": "job-1",
        }
        self.database.get_all.return_value = [match_snapshot]

        with patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ):
            response = self.client.get(
                "/api/resumes?client_id=client-1&job_id=job-1",
                headers=AUTH_HEADERS,
            )

        self.assertEqual(response.status_code, 200)
        result = response.json["resumes"][0]
        self.assertEqual(result["id"], "resume-123456")
        self.assertEqual(result["matchScore"], 91)
        self.assertEqual(result["matchRationale"], "Strong role fit.")
        self.assertTrue(result["recommended"])

    def test_resume_reclassification_moves_drive_file_and_updates_record(self):
        user_reference = self.database.collection.return_value.document.return_value
        user_reference.get.return_value.to_dict.return_value = {
            "resumeDriveFolderId": "resume-root"
        }
        resume_reference = (
            user_reference.collection.return_value.document.return_value
        )
        resume_snapshot = Mock()
        resume_snapshot.exists = True
        resume_snapshot.to_dict.return_value = {
            "driveFileId": "resume-file",
            "industry": "Other",
        }
        resume_reference.get.return_value = resume_snapshot
        drive = Mock()
        drive.files.return_value.get.return_value.execute.return_value = {
            "parents": ["old-folder"]
        }
        drive.files.return_value.list.return_value.execute.return_value = {"files": []}
        drive.files.return_value.create.return_value.execute.return_value = {
            "id": "banking-folder"
        }
        with patch(
            "backend.app.auth.verify_id_token", return_value=VERIFIED_CLAIMS
        ), patch(
            "backend.app.load_credentials_from_file",
            return_value=(Mock(), "test-project"),
        ), patch(
            "backend.app.build", return_value=drive
        ):
            response = self.client.patch(
                "/api/resumes/resume-123456",
                headers=AUTH_HEADERS,
                json={"industry": "Banking"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["industry"], "Banking")
        drive.files.return_value.update.assert_called_once_with(
            fileId="resume-file",
            addParents="banking-folder",
            removeParents="old-folder",
            fields="id,parents",
        )
        resume_reference.update.assert_called_once()
        self.assertEqual(
            resume_reference.update.call_args.args[0]["industry"], "Banking"
        )

    def test_candidate_name_extraction_skips_resume_headings(self):
        fields = extract_candidate_fields(
            "Resume\nExperience\nAda Lovelace\nada@example.com\nPython",
            "Candidate 123456",
        )

        self.assertEqual(fields["candidateName"], "Ada Lovelace")

    def test_resume_redaction_removes_contact_details(self):
        redacted = redact_resume_text(
            "Ada Lovelace, ada@example.com, +1 555 123 4567, Python",
            "Ada Lovelace",
        )

        self.assertNotIn("Ada Lovelace", redacted)
        self.assertNotIn("ada@example.com", redacted)
        self.assertNotIn("+1 555 123 4567", redacted)
        self.assertIn("Python", redacted)


if __name__ == "__main__":
    unittest.main()
