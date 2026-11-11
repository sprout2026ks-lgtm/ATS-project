const apiBaseUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:5000";

async function request(user, path, options = {}) {
  const token = await user.getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers });
  } catch {
    throw new Error(
      `Could not reach the ATS API at ${apiBaseUrl}. Start the Flask backend and check VITE_API_URL and CORS_ORIGINS.`,
    );
  }

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `The ATS API returned HTTP ${response.status}.`);
  }
  return response;
}

export async function apiJson(user, path, options) {
  const response = await request(user, path, options);
  return response.json();
}

export async function uploadResumes(user, clientId, files) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  const response = await request(
    user,
    `/api/clients/${encodeURIComponent(clientId)}/applicants`,
    { method: "POST", body: formData },
  );
  return response.json();
}

export async function downloadResume(user, clientId, applicantId) {
  const response = await request(
    user,
    `/api/clients/${encodeURIComponent(clientId)}/applicants/${encodeURIComponent(applicantId)}/resume`,
  );
  return response.blob();
}

export async function downloadReport(user, clientId) {
  const response = await request(
    user,
    `/api/clients/${encodeURIComponent(clientId)}/reports`,
  );
  return response.blob();
}

export async function saveProfile(user, displayName) {
  return apiJson(user, "/api/profile", {
    method: "POST",
    body: JSON.stringify({ displayName }),
  });
}
