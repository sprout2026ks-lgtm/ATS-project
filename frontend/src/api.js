const apiBaseUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:5000";

export async function saveProfile(user, displayName) {
  const token = await user.getIdToken(true);
  let response;
  try {
    response = await fetch(`${apiBaseUrl}/api/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName }),
    });
  } catch {
    throw new Error(
      `Could not reach the profile API at ${apiBaseUrl}. Start the Flask backend and check VITE_API_URL and CORS_ORIGINS.`,
    );
  }

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `The profile API returned HTTP ${response.status}.`);
  }

  return response.json();
}
