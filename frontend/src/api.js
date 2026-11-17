const apiBaseUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:5051";

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
    const failures = Array.isArray(result.failed)
      ? result.failed
        .map((item) => `${item.resumeFileName || "Resume"}: ${item.error || "Upload failed."}`)
        .join("; ")
      : "";
    throw new Error(
      [result.error || `The ATS API returned HTTP ${response.status}.`, failures]
        .filter(Boolean)
        .join(" "),
    );
  }
  return response;
}

export async function apiJson(user, path, options) {
  const response = await request(user, path, options);
  return response.json();
}

export async function uploadResumes(user, clientId, files, industry) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  formData.append("industry", industry);
  const response = await request(
    user,
    `/api/clients/${encodeURIComponent(clientId)}/applicants`,
    { method: "POST", body: formData },
  );
  return response.json();
}

export async function uploadLibraryResumes(user, files, industry) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  formData.append("industry", industry);
  const response = await request(user, "/api/resumes", {
    method: "POST",
    body: formData,
  });
  return response.json();
}

export async function downloadLibraryResume(user, resumeId) {
  const response = await request(
    user,
    `/api/resumes/${encodeURIComponent(resumeId)}/resume`,
  );
  return response.blob();
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
