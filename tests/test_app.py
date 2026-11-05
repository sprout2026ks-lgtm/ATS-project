import os
import unittest
from unittest.mock import Mock, patch

from backend.app import create_app


class ProfileApiTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"FIREBASE_PROJECT_ID": "test-project"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

        self.firebase_get_app = patch(
            "backend.app.firebase_admin.get_app", side_effect=ValueError
        )
        self.firebase_get_app.start()
        self.addCleanup(self.firebase_get_app.stop)
        self.firebase_initialize = patch("backend.app.firebase_admin.initialize_app")
        self.firebase_initialize.start()
        self.addCleanup(self.firebase_initialize.stop)
        self.database = Mock()
        self.firestore_client = patch(
            "backend.app.firestore.client", return_value=self.database
        )
        self.firestore_client.start()
        self.addCleanup(self.firestore_client.stop)

        self.app = create_app()
        self.client = self.app.test_client()

    def test_profile_requires_bearer_token(self):
        response = self.client.post("/api/profile", json={"displayName": "Ada"})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json["error"], "A Firebase bearer token is required")

    def test_health_endpoint_allows_local_frontend_origin(self):
        response = self.client.get(
            "/api/health", headers={"Origin": "http://localhost:5173"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["Access-Control-Allow-Origin"], "http://localhost:5173"
        )

    def test_profile_requires_display_name(self):
        with patch("backend.app.auth.verify_id_token", return_value={"uid": "user-1"}):
            response = self.client.post(
                "/api/profile",
                headers={"Authorization": "Bearer valid-token"},
                json={},
            )

        self.assertEqual(response.status_code, 400)
        self.database.collection.assert_not_called()

    def test_profile_requires_registered_email_and_verified_phone(self):
        claims = {"uid": "user-1", "email": "ada@example.com"}
        with patch("backend.app.auth.verify_id_token", return_value=claims):
            response = self.client.post(
                "/api/profile",
                headers={"Authorization": "Bearer valid-token"},
                json={"displayName": "Ada"},
            )

        self.assertEqual(response.status_code, 403)
        self.database.collection.assert_not_called()

    def test_profile_saves_verified_identity_to_firestore(self):
        claims = {
            "uid": "user-1",
            "email": "ada@example.com",
            "phone_number": "+15551234567",
        }
        with patch("backend.app.auth.verify_id_token", return_value=claims):
            response = self.client.post(
                "/api/profile",
                headers={"Authorization": "Bearer valid-token"},
                json={"displayName": "  Ada Lovelace  "},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"uid": "user-1", "profileSaved": True})
        self.database.collection.return_value.document.return_value.set.assert_called_once()
        saved_profile = self.database.collection.return_value.document.return_value.set.call_args.args[0]
        self.assertEqual(saved_profile["displayName"], "Ada Lovelace")
        self.assertEqual(saved_profile["email"], "ada@example.com")
        self.assertEqual(saved_profile["phoneNumber"], "+15551234567")


if __name__ == "__main__":
    unittest.main()
