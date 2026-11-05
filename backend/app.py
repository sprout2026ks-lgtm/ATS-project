import os
from pathlib import Path

import firebase_admin
from firebase_admin import auth, firestore
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from google.api_core.exceptions import GoogleAPIError

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def create_app():
    app = Flask(__name__)
    origins = [
        origin.strip()
        for origin in os.environ.get(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    ]
    CORS(app, resources={r"/api/*": {"origins": origins}})

    project_id = os.environ.get("FIREBASE_PROJECT_ID")
    if not project_id:
        raise RuntimeError("FIREBASE_PROJECT_ID must be configured")

    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(options={"projectId": project_id})
    database = firestore.client()

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    @app.post("/api/profile")
    def save_profile():
        authorization = request.headers.get("Authorization", "")
        scheme, separator, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not separator or not token.strip():
            return jsonify({"error": "A Firebase bearer token is required"}), 401

        try:
            claims = auth.verify_id_token(token.strip(), check_revoked=True)
        except (
            auth.InvalidIdTokenError,
            auth.ExpiredIdTokenError,
            auth.RevokedIdTokenError,
        ):
            return jsonify({"error": "The authentication token is invalid"}), 401
        except auth.CertificateFetchError:
            app.logger.exception("Could not retrieve Firebase token certificates")
            return jsonify({"error": "Authentication service is unavailable"}), 503

        body = request.get_json(silent=True)
        display_name = body.get("displayName") if isinstance(body, dict) else None
        if not isinstance(display_name, str) or not display_name.strip():
            return jsonify({"error": "A display name is required"}), 400

        uid = claims.get("uid")
        if not isinstance(uid, str) or not uid:
            return jsonify({"error": "The authentication token has no user ID"}), 401

        if not claims.get("email") or not claims.get("phone_number"):
            return jsonify(
                {"error": "A registered email and verified phone number are required"}
            ), 403

        profile = {
            "displayName": display_name.strip(),
            "email": claims.get("email"),
            "phoneNumber": claims.get("phone_number"),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }

        try:
            database.collection("users").document(uid).set(profile, merge=True)
        except GoogleAPIError:
            app.logger.exception("Could not save the user profile to Firestore")
            return jsonify({"error": "Profile service is unavailable"}), 503

        return jsonify({"uid": uid, "profileSaved": True}), 200

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))
