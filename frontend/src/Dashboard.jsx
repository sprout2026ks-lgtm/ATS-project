import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiJson,
  downloadReport,
  downloadLibraryResume,
  downloadResume,
  uploadLibraryResumes,
  uploadResumes,
} from "./api.js";

const navigation = [
  ["overview", "Overview"],
  ["clients", "Clients"],
  ["jobs", "Job requirements"],
  ["resume-library", "Resume library"],
  ["candidates", "Candidates"],
  ["shortlist", "Shortlist"],
  ["reports", "Reports"],
];
const statuses = ["New", "Reviewed", "Shortlisted", "Rejected", "Hired"];
const industries = ["IT", "Banking", "Medical", "Other"];

function splitSkills(value) {
  return value.split(",").map((skill) => skill.trim()).filter(Boolean);
}

async function uploadInBatches(files, uploadBatch, onProgress) {
  let uploadedCount = 0;
  const failed = [];
  const batchSize = 8;

  for (let start = 0; start < files.length; start += batchSize) {
    const batch = files.slice(start, start + batchSize);
    onProgress(`Uploading ${Math.min(start + batch.length, files.length)} of ${files.length} resumes…`);
    const result = await uploadBatch(batch);
    uploadedCount += result.uploaded.length;
    failed.push(...result.failed);
  }

  return { uploadedCount, failed };
}

function Dashboard({ authUser, onSignOut }) {
  const [activePage, setActivePage] = useState("overview");
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState("");
  const [jobs, setJobs] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [resumes, setResumes] = useState([]);
  const [aiStatus, setAiStatus] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [industryFilter, setIndustryFilter] = useState("All");
  const [uploadIndustry, setUploadIndustry] = useState("Other");
  const [includePii, setIncludePii] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [analyzingId, setAnalyzingId] = useState("");
  const [matchingResumeId, setMatchingResumeId] = useState("");
  const [autoAnalysisMessage, setAutoAnalysisMessage] = useState("");
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportRevision, setReportRevision] = useState(0);
  const autoAnalysisJobs = useRef(new Set());
  const refreshWorkspaceRef = useRef(null);
  const [clientForm, setClientForm] = useState({
    organizationName: "",
    contactPerson: "",
    email: "",
    contactNumber: "",
    companyNature: "",
    location: "",
  });
  const [jobForm, setJobForm] = useState({
    title: "",
    description: "",
    requiredSkills: "",
    preferredSkills: "",
    minimumExperience: "0",
  });

  const selectedClient = clients.find((client) => client.id === clientId);
  const openJobs = useMemo(() => jobs.filter((job) => job.status === "Open"), [jobs]);
  const displayedCandidates = useMemo(() => {
    const source = activePage === "shortlist"
      ? candidates.filter((candidate) => candidate.status === "Shortlisted")
      : candidates;
    return statusFilter === "All"
      ? source
      : source.filter((candidate) => candidate.status === statusFilter);
  }, [activePage, candidates, statusFilter]);
  const displayedResumes = useMemo(
    () => resumes.filter((resume) => (
      (activePage !== "shortlist" || resume.status === "Shortlisted")
      && (statusFilter === "All" || (resume.status || "New") === statusFilter)
    )),
    [activePage, resumes, statusFilter],
  );
  const shortlistedCount = candidates.filter(
    (candidate) => candidate.status === "Shortlisted",
  ).length;
  const resumeRecommendedCount = resumes.filter((resume) => resume.recommended).length;
  const resumeShortlistedCount = resumes.filter(
    (resume) => resume.status === "Shortlisted",
  ).length;
  const recommendedCount = candidates.filter((candidate) => candidate.recommended).length;

  const refreshWorkspace = useCallback(async () => {
    const resumeQuery = new URLSearchParams({
      include_pii: String(includePii),
    });
    if (industryFilter !== "All") resumeQuery.set("industry", industryFilter);
    if (search.trim()) resumeQuery.set("search", search.trim());
    if (clientId && selectedJobId) {
      resumeQuery.set("client_id", clientId);
      resumeQuery.set("job_id", selectedJobId);
    }
    const resumeRequest = apiJson(
      authUser,
      `/api/resumes?${resumeQuery.toString()}`,
    );
    if (!clientId) {
      setJobs([]);
      setCandidates([]);
      setResumes((await resumeRequest).resumes);
      return;
    }
    const query = new URLSearchParams({ include_pii: String(includePii) });
    if (industryFilter !== "All") query.set("industry", industryFilter);
    if (search.trim()) query.set("search", search.trim());
    const [jobResult, candidateResult, resumeResult] = await Promise.all([
      apiJson(authUser, `/api/clients/${encodeURIComponent(clientId)}/jobs`),
      apiJson(
        authUser,
        `/api/clients/${encodeURIComponent(clientId)}/applicants?${query.toString()}`,
      ),
      resumeRequest,
    ]);
    setJobs(jobResult.jobs);
    setCandidates(candidateResult.applicants);
    setResumes(resumeResult.resumes);
  }, [authUser, clientId, includePii, industryFilter, search, selectedJobId]);
  refreshWorkspaceRef.current = refreshWorkspace;

  useEffect(() => {
    let active = true;
    Promise.all([
      apiJson(authUser, "/api/clients"),
      apiJson(authUser, "/api/ai/status"),
    ]).then(([clientResult, aiResult]) => {
      if (!active) return;
      setClients(clientResult.clients);
      setClientId((current) => (
        clientResult.clients.some((client) => client.id === current)
          ? current
          : clientResult.clients[0]?.id || ""
      ));
      setAiStatus(aiResult);
    }).catch((loadError) => {
      if (active) setError(loadError.message);
    });
    return () => { active = false; };
  }, [authUser]);

  useEffect(() => {
    let active = true;
    refreshWorkspace().catch((loadError) => {
      if (active) setError(loadError.message);
    });
    return () => { active = false; };
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!openJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(openJobs[0]?.id || "");
    }
  }, [openJobs, selectedJobId]);

  useEffect(() => {
    if (
      !["candidates", "resume-library", "reports"].includes(activePage)
      || !clientId
      || !selectedJobId
      || !aiStatus?.enabled
    ) {
      return undefined;
    }

    const key = `${clientId}:${selectedJobId}`;
    if (autoAnalysisJobs.current.has(key)) return undefined;
    autoAnalysisJobs.current.add(key);
    let active = true;

    async function analyzePendingResumes() {
      setAutoAnalysisMessage("Checking existing resumes for saved job analyses…");
      try {
        const [candidateResult, resumeResult] = await Promise.all([
          apiJson(
            authUser,
            `/api/clients/${encodeURIComponent(clientId)}/applicants`,
          ),
          apiJson(
            authUser,
            `/api/resumes?client_id=${encodeURIComponent(clientId)}&job_id=${encodeURIComponent(selectedJobId)}`,
          ),
        ]);
        if (!active) return;

        const pending = [
          ...candidateResult.applicants
            .filter((candidate) => (
              candidate.matchScore == null
              || candidate.analyzedJobId !== selectedJobId
            ))
            .map((candidate) => ({
              id: candidate.id,
              name: candidate.candidateName,
              path: `/api/clients/${encodeURIComponent(clientId)}/applicants/${encodeURIComponent(candidate.id)}/analyze`,
              body: { jobId: selectedJobId },
              type: "candidate",
            })),
          ...resumeResult.resumes
            .filter((resume) => resume.matchScore == null)
            .map((resume) => ({
              id: resume.id,
              name: resume.candidateName,
              path: `/api/resumes/${encodeURIComponent(resume.id)}/analyze`,
              body: { clientId, jobId: selectedJobId },
              type: "resume",
            })),
        ];

        if (pending.length === 0) {
          setAutoAnalysisMessage("");
          return;
        }

        let analyzedCount = 0;
        const failures = [];
        for (const [index, item] of pending.entries()) {
          if (!active) return;
          setAutoAnalysisMessage(
            `Automatically analyzing ${index + 1} of ${pending.length}: ${item.name}…`,
          );
          if (item.type === "candidate") setAnalyzingId(item.id);
          else setMatchingResumeId(item.id);
          try {
            await apiJson(authUser, item.path, {
              method: "POST",
              body: JSON.stringify(item.body),
            });
            analyzedCount += 1;
          } catch (analysisError) {
            failures.push(`${item.name}: ${analysisError.message}`);
          } finally {
            if (item.type === "candidate") setAnalyzingId("");
            else setMatchingResumeId("");
          }
        }

        if (!active) return;
        await refreshWorkspaceRef.current();
        setReportRevision((revision) => revision + 1);
        setAutoAnalysisMessage("");
        if (failures.length) {
          setError(
            `${analyzedCount} resumes analyzed; ${failures.length} could not be analyzed. ${failures.slice(0, 3).join("; ")}`,
          );
        } else {
          setNotice(`${analyzedCount} resumes automatically analyzed for the selected job.`);
        }
      } catch (analysisError) {
        if (active) {
          setAutoAnalysisMessage("");
          setError(analysisError.message);
        }
      }
    }

    analyzePendingResumes();
    return () => {
      active = false;
      autoAnalysisJobs.current.delete(key);
    };
  }, [activePage, aiStatus?.enabled, authUser, clientId, selectedJobId]);

  useEffect(() => {
    if (activePage !== "reports" || !clientId) {
      setReport(null);
      return undefined;
    }
    let active = true;
    setReportLoading(true);
    apiJson(
      authUser,
      `/api/clients/${encodeURIComponent(clientId)}/reports/data`,
    ).then((result) => {
      if (active) setReport(result);
    }).catch((reportError) => {
      if (active) setError(reportError.message);
    }).finally(() => {
      if (active) setReportLoading(false);
    });
    return () => { active = false; };
  }, [activePage, authUser, clientId, reportRevision]);

  async function runAction(action, successMessage) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await action();
      if (successMessage) setNotice(successMessage);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createClient(event) {
    event.preventDefault();
    await runAction(async () => {
      const result = await apiJson(authUser, "/api/clients", {
        method: "POST",
        body: JSON.stringify(clientForm),
      });
      setClients((current) => [...current, result.client]);
      setClientId(result.client.id);
      setSelectedJobId("");
      setClientForm({
        organizationName: "",
        contactPerson: "",
        email: "",
        contactNumber: "",
        companyNature: "",
        location: "",
      });
    }, "Client added.");
  }

  async function archiveClient(client) {
    if (!window.confirm(`Archive ${client.organizationName}? Existing candidate data will be retained.`)) {
      return;
    }
    await runAction(async () => {
      await apiJson(authUser, `/api/clients/${encodeURIComponent(client.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      const remaining = clients.filter((item) => item.id !== client.id);
      setClients(remaining);
      if (clientId === client.id) {
        setClientId(remaining[0]?.id || "");
        setSelectedJobId("");
      }
    }, "Client archived.");
  }

  async function createJob(event) {
    event.preventDefault();
    await runAction(async () => {
      await apiJson(authUser, `/api/clients/${encodeURIComponent(clientId)}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          ...jobForm,
          minimumExperience: Number(jobForm.minimumExperience),
          requiredSkills: splitSkills(jobForm.requiredSkills),
          preferredSkills: splitSkills(jobForm.preferredSkills),
        }),
      });
      setJobForm({
        title: "",
        description: "",
        requiredSkills: "",
        preferredSkills: "",
        minimumExperience: "0",
      });
      await refreshWorkspace();
    }, "Job requirement created.");
  }

  async function toggleJob(job) {
    await runAction(async () => {
      await apiJson(
        authUser,
        `/api/clients/${encodeURIComponent(clientId)}/jobs/${encodeURIComponent(job.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: job.status === "Open" ? "Closed" : "Open" }),
        },
      );
      await refreshWorkspace();
    }, "Job status updated.");
  }

  async function uploadSelectedFiles(files, form, uploadBatch) {
    setError("");
    setNotice("");
    setBusy(true);
    let uploadedCount = 0;
    try {
      const result = await uploadInBatches(
        files,
        uploadBatch,
        setUploadProgress,
      );
      uploadedCount = result.uploadedCount;
      await refreshWorkspace();
      const successMessage = `${uploadedCount} resume${uploadedCount === 1 ? "" : "s"} uploaded.`;
      if (result.failed.length) {
        const failures = result.failed
          .map((item) => `${item.resumeFileName}: ${item.error}`)
          .join("; ");
        setError(`${successMessage} Upload failures: ${failures}`);
      } else {
        setNotice(successMessage);
      }
    } catch (uploadError) {
      const progress = uploadedCount
        ? ` ${uploadedCount} resume${uploadedCount === 1 ? "" : "s"} uploaded before the error.`
        : "";
      setError(`${uploadError.message}${progress}`);
    } finally {
      setUploadProgress("");
      setBusy(false);
      form.reset();
    }
  }

  async function uploadFiles(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const files = Array.from(form.elements.resumes.files);
    if (!files.length) return;
    await uploadSelectedFiles(
      files,
      form,
      (batch) => uploadLibraryResumes(authUser, batch, uploadIndustry),
    );
  }

  async function uploadCandidates(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const files = Array.from(form.elements.resumes.files);
    if (!files.length) return;
    if (!clientId) {
      setError("Select a client before uploading candidates.");
      return;
    }
    await uploadSelectedFiles(
      files,
      form,
      (batch) => uploadResumes(authUser, clientId, batch, uploadIndustry),
    );
  }

  async function analyzeCandidate(candidate) {
    setError("");
    setNotice("");
    setAnalyzingId(candidate.id);
    try {
      if (!selectedJobId) throw new Error("Create or select an open job requirement first.");
      await apiJson(
        authUser,
        `/api/clients/${encodeURIComponent(clientId)}/applicants/${encodeURIComponent(candidate.id)}/analyze`,
        {
          method: "POST",
          body: JSON.stringify({ jobId: selectedJobId }),
        },
      );
      await refreshWorkspace();
      setNotice("Candidate match analysis completed.");
    } catch (analysisError) {
      setError(analysisError.message);
    } finally {
      setAnalyzingId("");
    }
  }

  async function analyzeResume(resume) {
    setError("");
    setNotice("");
    setMatchingResumeId(resume.id);
    try {
      if (!clientId || !selectedJobId) {
        throw new Error("Select a client and open job requirement first.");
      }
      await apiJson(
        authUser,
        `/api/resumes/${encodeURIComponent(resume.id)}/analyze`,
        {
          method: "POST",
          body: JSON.stringify({ clientId, jobId: selectedJobId }),
        },
      );
      await refreshWorkspace();
      setNotice("Resume match analysis completed.");
    } catch (analysisError) {
      setError(analysisError.message);
    } finally {
      setMatchingResumeId("");
    }
  }

  async function setResumeStatus(resume, status) {
    await runAction(async () => {
      await apiJson(
        authUser,
        `/api/resumes/${encodeURIComponent(resume.id)}/match`,
        {
          method: "PATCH",
          body: JSON.stringify({ clientId, jobId: selectedJobId, status }),
        },
      );
      await refreshWorkspace();
    }, `Candidate moved to ${status.toLowerCase()}.`);
  }

  async function setResumeIndustry(resume, industry) {
    await runAction(async () => {
      await apiJson(
        authUser,
        `/api/resumes/${encodeURIComponent(resume.id)}`,
        { method: "PATCH", body: JSON.stringify({ industry }) },
      );
      await refreshWorkspace();
    }, `Resume moved to the ${industry} Drive folder.`);
  }

  async function openLibraryResume(resume) {
    await runAction(async () => {
      const blob = await downloadLibraryResume(authUser, resume.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = resume.resumeFileName || "resume";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  async function setCandidateStatus(candidate, status) {
    await runAction(async () => {
      await apiJson(
        authUser,
        `/api/clients/${encodeURIComponent(clientId)}/applicants/${encodeURIComponent(candidate.id)}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      );
      await refreshWorkspace();
    }, `Candidate moved to ${status.toLowerCase()}.`);
  }

  async function openResume(candidate) {
    await runAction(async () => {
      const blob = await downloadResume(authUser, clientId, candidate.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = candidate.resumeFileName || "resume";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  async function exportReport() {
    await runAction(async () => {
      const blob = await downloadReport(authUser, clientId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "recruitment-report.csv";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "Recruitment report downloaded.");
  }

  return (
    <main className="ats-shell">
      <aside className="ats-sidebar">
        <div className="ats-brand"><span className="brand-mark">A</span><strong>ATS workspace</strong></div>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="ATS workspace">
          {navigation.map(([page, label]) => (
            <button
              className={`nav-item ${activePage === page ? "active" : ""}`}
              key={page}
              onClick={() => setActivePage(page)}
              type="button"
            >
              <span aria-hidden="true">{({
                overview: "◫", clients: "▣", jobs: "▤", "resume-library": "▧", candidates: "♙",
                shortlist: "☆", reports: "▥",
              })[page]}</span>
              {label}
              {page === "shortlist" && resumeShortlistedCount + shortlistedCount > 0 && <span className="nav-count">{resumeShortlistedCount + shortlistedCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="user-avatar">{(authUser.displayName || authUser.email || "U").slice(0, 1).toUpperCase()}</span>
          <div className="user-identity"><strong>{authUser.displayName || "Recruiter"}</strong><span>{authUser.email}</span></div>
          <button className="icon-button" type="button" onClick={onSignOut} aria-label="Sign out">↗</button>
        </div>
      </aside>

      <section className="ats-main">
        <header className="topbar">
          <div>
            <p className="eyebrow">RECRUITMENT WORKSPACE</p>
            <h1>{navigation.find(([page]) => page === activePage)?.[1]}</h1>
          </div>
          {clients.length > 0 && (
            <label className="client-picker">
              <span>Active client</span>
              <select value={clientId} onChange={(event) => { setClientId(event.target.value); setSelectedJobId(""); }}>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.organizationName}</option>)}
              </select>
            </label>
          )}
        </header>

        {(error || notice) && (
          <div className={`dashboard-message ${error ? "error-message" : "success-message"}`} role={error ? "alert" : "status"}>
            {error || notice}
            <button type="button" aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}>×</button>
          </div>
        )}

        {activePage === "overview" && (
          <div className="dashboard-content">
            <section className="welcome-panel">
              <div><p className="eyebrow">YOUR PIPELINE AT A GLANCE</p><h2>{selectedClient?.organizationName || "Welcome to your ATS"}</h2><p>Manage requirements, discover talent, and keep every hiring decision in one place.</p></div>
              <button className="primary-button compact-button" type="button" onClick={() => setActivePage("resume-library")}>Upload resumes</button>
            </section>
            <div className="stat-grid">
              <article className="stat-card"><span>Active jobs</span><strong>{openJobs.length}</strong><small>For the selected client</small></article>
              <article className="stat-card"><span>Resume library</span><strong>{resumes.length}</strong><small>Stored independently of clients</small></article>
              <article className="stat-card"><span>AI recommendations</span><strong>{resumeRecommendedCount}</strong><small>For the selected job; human review required</small></article>
              <article className="stat-card"><span>Shortlisted</span><strong>{resumeShortlistedCount}</strong><small>For the selected job</small></article>
            </div>
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">CURRENT CLIENT</p><h2>{selectedClient?.organizationName || "No client selected"}</h2></div><button className="secondary-button" type="button" onClick={() => setActivePage("clients")}>Manage clients</button></div>
              <p className="muted">{selectedClient ? `${openJobs.length} open job${openJobs.length === 1 ? "" : "s"} · ${resumes.length} resumes in your shared library` : "Add a recruitment client to get started."}</p>
              {aiStatus && !aiStatus.enabled && <p className="inline-notice">AI matching is not configured. Add OPENROUTER_API_KEY and OPENROUTER_MODEL to the backend environment to enable candidate analysis.</p>}
            </section>
          </div>
        )}

        {activePage === "clients" && (
          <div className="dashboard-content split-layout">
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">CLIENT PORTFOLIO</p><h2>Recruitment clients</h2></div></div>
              {clients.length === 0 ? <p className="empty-state">No clients yet. Add your first organization.</p> : (
                <div className="client-list">
                  {clients.map((client) => (
                    <article className={`client-row ${client.id === clientId ? "selected" : ""}`} key={client.id}>
                      <button type="button" className="client-select" onClick={() => { setClientId(client.id); setSelectedJobId(""); }}>
                        <strong>{client.organizationName}</strong><span>{client.contactPerson || client.companyNature || "Recruitment client"}</span>
                      </button>
                      <button className="text-button" type="button" onClick={() => archiveClient(client)}>Archive</button>
                    </article>
                  ))}
                </div>
              )}
            </section>
            <form className="panel form-panel" onSubmit={createClient}>
              <p className="eyebrow">NEW ORGANIZATION</p><h2>Add a client</h2>
              <label>Organization name<input value={clientForm.organizationName} onChange={(event) => setClientForm({ ...clientForm, organizationName: event.target.value })} required maxLength={200} /></label>
              <label>Contact person<input value={clientForm.contactPerson} onChange={(event) => setClientForm({ ...clientForm, contactPerson: event.target.value })} maxLength={200} /></label>
              <label>Contact email<input type="email" value={clientForm.email} onChange={(event) => setClientForm({ ...clientForm, email: event.target.value })} maxLength={200} /></label>
              <label>Contact phone<input value={clientForm.contactNumber} onChange={(event) => setClientForm({ ...clientForm, contactNumber: event.target.value })} maxLength={200} /></label>
              <label>Industry<select value={clientForm.companyNature} onChange={(event) => setClientForm({ ...clientForm, companyNature: event.target.value })}><option value="">Select an industry</option>{industries.filter((industry) => industry !== "Other").map((industry) => <option key={industry}>{industry}</option>)}<option>Other</option></select></label>
              <label>Location<input value={clientForm.location} onChange={(event) => setClientForm({ ...clientForm, location: event.target.value })} maxLength={200} /></label>
              <button className="primary-button" type="submit" disabled={busy}>Add client</button>
            </form>
          </div>
        )}

        {activePage === "jobs" && (
          <div className="dashboard-content split-layout">
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">ROLE PIPELINE</p><h2>Job requirements</h2></div><span className="soft-badge">{openJobs.length} open</span></div>
              {!clientId ? <p className="empty-state">Add or select a client to manage its requirements.</p> : jobs.length === 0 ? <p className="empty-state">No requirements yet. Create a role for this client.</p> : (
                <div className="job-list">
                  {jobs.map((job) => (
                    <article className="job-card" key={job.id}>
                      <div className="panel-heading"><div><h3>{job.title}</h3><span className={`status-pill ${job.status === "Open" ? "status-open" : ""}`}>{job.status}</span></div><button className="secondary-button" type="button" onClick={() => toggleJob(job)}>{job.status === "Open" ? "Close role" : "Reopen"}</button></div>
                      <p className="muted">{job.description || "No additional description."}</p>
                      <div className="tag-row">{(job.requiredSkills || []).map((skill) => <span className="skill-tag" key={skill}>{skill}</span>)}</div>
                      <small className="muted">Minimum experience: {job.minimumExperience || 0} years</small>
                    </article>
                  ))}
                </div>
              )}
            </section>
            <form className="panel form-panel" onSubmit={createJob}>
              <p className="eyebrow">DEFINE A ROLE</p><h2>New requirement</h2>
              <label>Job title<input value={jobForm.title} onChange={(event) => setJobForm({ ...jobForm, title: event.target.value })} required maxLength={200} disabled={!clientId} /></label>
              <label>Description<textarea rows="4" value={jobForm.description} onChange={(event) => setJobForm({ ...jobForm, description: event.target.value })} maxLength={5000} disabled={!clientId} /></label>
              <label>Required skills <span className="field-hint">Comma-separated</span><input value={jobForm.requiredSkills} onChange={(event) => setJobForm({ ...jobForm, requiredSkills: event.target.value })} placeholder="Python, SQL, communication" disabled={!clientId} /></label>
              <label>Preferred skills <span className="field-hint">Comma-separated</span><input value={jobForm.preferredSkills} onChange={(event) => setJobForm({ ...jobForm, preferredSkills: event.target.value })} disabled={!clientId} /></label>
              <label>Minimum experience (years)<input type="number" min="0" max="60" step="0.5" value={jobForm.minimumExperience} onChange={(event) => setJobForm({ ...jobForm, minimumExperience: event.target.value })} disabled={!clientId} /></label>
              <button className="primary-button" type="submit" disabled={busy || !clientId}>Create requirement</button>
            </form>
          </div>
        )}

        {(activePage === "resume-library" || activePage === "shortlist") && (
          <div className="dashboard-content">
            {activePage === "resume-library" && <section className="panel upload-panel">
              <div>
                <p className="eyebrow">PRIVATE DRIVE STORAGE</p>
                <h2>Upload resumes</h2>
                <p className="muted">Choose an industry to store PDF or DOCX resumes in a matching private Drive folder.</p>
              </div>
              <form className="upload-form" onSubmit={uploadFiles}>
                <label className="industry-select">Industry<select value={uploadIndustry} onChange={(event) => setUploadIndustry(event.target.value)} disabled={busy}>{industries.map((industry) => <option key={industry}>{industry}</option>)}</select></label>
                <input type="file" name="resumes" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple required disabled={busy} />
                <button className="primary-button compact-button" type="submit" disabled={busy}>Upload resumes</button>
              </form>
              {uploadProgress && <p className="muted" role="status">{uploadProgress}</p>}
            </section>}
            <section className="panel">
              <div className="panel-heading">
                <div><p className="eyebrow">AI-ASSISTED SCREENING</p><h2>{activePage === "shortlist" ? "Shortlisted matches" : "Match resumes to a job"}</h2></div>
                <span className="soft-badge">{displayedResumes.length} resumes</span>
              </div>
              <div className="candidate-controls">
                <label className="compact-select">
                  <span className="sr-only">Job requirement for resume matching</span>
                  <select value={selectedJobId} onChange={(event) => setSelectedJobId(event.target.value)} disabled={!clientId || !openJobs.length}>
                    <option value="">Select an open job</option>
                    {openJobs.map((job) => <option value={job.id} key={job.id}>{job.title}</option>)}
                  </select>
                </label>
                <label className="compact-select"><span className="sr-only">Filter resumes by industry</span><select value={industryFilter} onChange={(event) => setIndustryFilter(event.target.value)}><option value="All">All industries</option>{industries.map((industry) => <option key={industry}>{industry}</option>)}</select></label>
                <label className="search-field"><span className="sr-only">Search resumes</span><input type="search" placeholder="Search candidates, skills, filenames…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
                <label className="compact-select"><span className="sr-only">Filter by match status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>All</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>
                <label className="privacy-toggle"><input type="checkbox" checked={includePii} onChange={(event) => setIncludePii(event.target.checked)} /> Reveal personal details</label>
              </div>
              {(!clientId || !selectedJobId) && <p className="inline-notice">Choose a client and create or select an open job requirement to see job-specific scores and recommendations.</p>}
              {aiStatus && !aiStatus.enabled && <p className="inline-notice">AI matching is disabled until OPENROUTER_API_KEY and OPENROUTER_MODEL are set in the backend environment.</p>}
              {displayedResumes.length === 0 ? <p className="empty-state">{activePage === "shortlist" ? "No resumes have been shortlisted for this job yet." : "No resumes found. Upload resumes here; you can match them to any client job later."}</p> : (
                <div className="table-scroll">
                  <table className="candidate-table">
                    <thead><tr><th>Candidate</th><th>Resume</th><th>Industry</th><th>Skills detected</th><th>Job match</th><th>Decision</th><th>Actions</th></tr></thead>
                    <tbody>
                      {displayedResumes.map((resume) => (
                        <tr key={resume.id}>
                          <td><strong>{resume.candidateName}</strong>{resume.recommended && <span className="recommend-badge">Recommended</span>}{includePii && <small>{resume.email || "No email extracted"}<br />{resume.contactNumber || "No phone extracted"}</small>}</td>
                          <td>{resume.resumeFileName}<button className="table-link" type="button" onClick={() => openLibraryResume(resume)}>Download</button></td>
                          <td><select className="status-select" value={resume.industry || "Other"} onChange={(event) => setResumeIndustry(resume, event.target.value)} aria-label={`Move ${resume.resumeFileName} to an industry folder`} disabled={busy}>{industries.map((industry) => <option key={industry}>{industry}</option>)}</select></td>
                          <td><div className="tag-row">{(resume.skills || []).slice(0, 5).map((skill) => <span className="skill-tag" key={skill}>{skill}</span>)}</div>{resume.totalExperience > 0 && <small>{resume.totalExperience} yrs experience</small>}</td>
                          <td>{resume.matchScore == null ? <span className="muted">Not analyzed</span> : <strong className="score-value">{resume.matchScore}%</strong>}{resume.matchRationale && <small className="match-rationale" title={resume.matchRationale}>{resume.matchRationale}</small>}</td>
                          <td>{resume.matchScore == null ? <span className="muted">—</span> : <select className="status-select" value={resume.status || "New"} onChange={(event) => setResumeStatus(resume, event.target.value)} aria-label={`Set shortlist status for ${resume.candidateName}`} disabled={busy}>{statuses.map((status) => <option key={status}>{status}</option>)}</select>}</td>
                          <td><div className="action-stack"><button className="table-link" type="button" disabled={!aiStatus?.enabled || matchingResumeId === resume.id || !clientId || !selectedJobId} onClick={() => analyzeResume(resume)}>{matchingResumeId === resume.id ? "Analyzing…" : "Analyze match"}</button></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {resumes.some((resume) => resume.recommended) && <p className="muted">Recommended matches have a score of 75% or higher. Scores are advisory; review each resume before shortlisting.</p>}
            </section>
          </div>
        )}

        {(activePage === "candidates" || activePage === "shortlist") && (
          <div className="dashboard-content">
            {activePage === "candidates" && (
              <section className="panel upload-panel">
                <div>
                  <p className="eyebrow">CLIENT CANDIDATE PIPELINE</p>
                  <h2>Upload candidates</h2>
                  <p className="muted">Store resumes in this client’s private Drive folder and add candidates directly to its pipeline.</p>
                </div>
                <form className="upload-form" onSubmit={uploadCandidates}>
                  <label className="industry-select">Industry<select value={uploadIndustry} onChange={(event) => setUploadIndustry(event.target.value)} disabled={busy || !clientId}>{industries.map((industry) => <option key={industry}>{industry}</option>)}</select></label>
                  <input type="file" name="resumes" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple required disabled={busy || !clientId} />
                  <button className="primary-button compact-button" type="submit" disabled={busy || !clientId}>Upload candidates</button>
                </form>
                {uploadProgress && <p className="muted" role="status">{uploadProgress}</p>}
              </section>
            )}
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">{activePage === "shortlist" ? "HUMAN-SELECTED TALENT" : "CANDIDATE PIPELINE"}</p><h2>{activePage === "shortlist" ? "Shortlisted candidates" : "Candidates"}</h2></div><span className="soft-badge">{displayedCandidates.length} shown</span></div>
              <div className="candidate-controls">
                <label className="search-field"><span className="sr-only">Search candidates</span><input type="search" placeholder="Search candidates, skills, filenames…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
                <label className="compact-select"><span className="sr-only">Filter candidates by industry</span><select value={industryFilter} onChange={(event) => setIndustryFilter(event.target.value)}><option value="All">All industries</option>{industries.map((industry) => <option key={industry}>{industry}</option>)}</select></label>
                <label className="compact-select"><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>All</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>
                <label className="privacy-toggle"><input type="checkbox" checked={includePii} onChange={(event) => setIncludePii(event.target.checked)} /> Reveal personal details</label>
                {activePage === "candidates" && <label className="compact-select"><span className="sr-only">Job for AI analysis</span><select value={selectedJobId} onChange={(event) => setSelectedJobId(event.target.value)}><option value="">Select job</option>{openJobs.map((job) => <option value={job.id} key={job.id}>{job.title}</option>)}</select></label>}
              </div>
              {displayedCandidates.length === 0 ? <p className="empty-state">{activePage === "shortlist" ? "No candidates have been shortlisted yet." : "No candidates found. Upload resumes to start the pipeline."}</p> : (
                <div className="table-scroll">
                  <table className="candidate-table">
                    <thead><tr><th>Candidate</th><th>Resume</th><th>Industry</th><th>Skills detected</th><th>Match</th><th>Status</th><th>Actions</th></tr></thead>
                    <tbody>
                      {displayedCandidates.map((candidate) => (
                        <tr key={candidate.id}>
                          <td><strong>{candidate.candidateName}</strong>{candidate.recommended && <span className="recommend-badge">Recommended</span>}{includePii && <small>{candidate.email || "No email extracted"}<br />{candidate.contactNumber || "No phone extracted"}</small>}</td>
                          <td>{candidate.resumeFileName}<button className="table-link" type="button" onClick={() => openResume(candidate)}>Download</button></td>
                          <td>{candidate.industry || "Other"}</td>
                          <td><div className="tag-row">{(candidate.skills || []).slice(0, 5).map((skill) => <span className="skill-tag" key={skill}>{skill}</span>)}</div>{candidate.totalExperience > 0 && <small>{candidate.totalExperience} yrs experience</small>}</td>
                          <td>{candidate.matchScore == null ? <span className="muted">Not analyzed</span> : <strong className="score-value">{candidate.matchScore}%</strong>}{candidate.matchRationale && <small className="match-rationale" title={candidate.matchRationale}>{candidate.matchRationale}</small>}</td>
                          <td><select className="status-select" value={candidate.status} onChange={(event) => setCandidateStatus(candidate, event.target.value)} aria-label={`Set status for ${candidate.candidateName}`}>{statuses.map((status) => <option key={status}>{status}</option>)}</select></td>
                          <td><div className="action-stack">{activePage === "candidates" && <button className="table-link" type="button" disabled={!aiStatus?.enabled || analyzingId === candidate.id || !selectedJobId} onClick={() => analyzeCandidate(candidate)}>{analyzingId === candidate.id ? "Analyzing…" : "Analyze match"}</button>}{candidate.status !== "Shortlisted" && <button className="table-link" type="button" onClick={() => setCandidateStatus(candidate, "Shortlisted")}>Shortlist</button>}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {aiStatus && !aiStatus.enabled && <p className="inline-notice">AI analysis is disabled until OPENROUTER_API_KEY and OPENROUTER_MODEL are set in the backend environment.</p>}
            </section>
          </div>
        )}

        {activePage === "reports" && (
          <div className="dashboard-content">
            <section className="welcome-panel report-banner"><div><p className="eyebrow">RECRUITMENT ANALYTICS</p><h2>Pipeline report</h2><p>Reports include client candidates and saved AI matches from the resume library. AI analyses run automatically for unanalysed resumes when a client and open job are selected.</p></div><button className="primary-button compact-button" type="button" onClick={exportReport} disabled={!clientId || busy}>Download CSV</button></section>
            {autoAnalysisMessage && <p className="inline-notice" role="status">{autoAnalysisMessage}</p>}
            {!clientId && <p className="empty-state">Add or select a client to view its recruitment report.</p>}
            {reportLoading && <p className="muted" role="status">Loading report…</p>}
            <div className="stat-grid">
              <article className="stat-card"><span>Open jobs</span><strong>{report?.openJobs ?? 0}</strong></article>
              <article className="stat-card"><span>AI recommendations</span><strong>{report?.recommended ?? 0}</strong></article>
              <article className="stat-card"><span>Shortlisted</span><strong>{report?.statusCounts?.Shortlisted ?? 0}</strong></article>
              <article className="stat-card"><span>Candidates and matched resumes</span><strong>{report?.totalCandidates ?? 0}</strong></article>
              <article className="stat-card"><span>AI analyses</span><strong>{report?.analyzedCount ?? 0}</strong></article>
              <article className="stat-card"><span>Average match score</span><strong>{report?.averageMatchScore == null ? "—" : `${report.averageMatchScore}%`}</strong></article>
            </div>
            <section className="panel"><div className="panel-heading"><div><p className="eyebrow">PIPELINE STAGES</p><h2>Candidate status breakdown</h2></div></div><div className="stage-grid">{statuses.map((status) => <div className="stage-card" key={status}><span>{status}</span><strong>{report?.statusCounts?.[status] ?? 0}</strong></div>)}</div></section>
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">SAVED AI RESULTS</p><h2>Resume match analyses</h2></div><span className="soft-badge">{report?.analyses?.length ?? 0} analyses</span></div>
              {!report?.analyses?.length ? <p className="empty-state">{reportLoading ? "Loading analyses…" : "No saved AI analyses yet. Unanalysed resumes are analyzed automatically for the selected job when AI matching is enabled."}</p> : (
                <div className="table-scroll">
                  <table className="candidate-table">
                    <thead><tr><th>Candidate</th><th>Resume</th><th>Industry</th><th>Job</th><th>Match</th><th>Decision</th><th>AI rationale</th></tr></thead>
                    <tbody>{report.analyses.map((analysis, index) => (
                      <tr key={`${analysis.resumeFileName}-${analysis.jobTitle}-${index}`}>
                        <td><strong>{analysis.candidateName}</strong></td>
                        <td>{analysis.resumeFileName}</td>
                        <td>{analysis.industry}</td>
                        <td>{analysis.jobTitle}</td>
                        <td><strong className="score-value">{analysis.matchScore}%</strong></td>
                        <td>{analysis.status}{analysis.recommended && <span className="recommend-badge">Recommended</span>}</td>
                        <td><small>{analysis.matchRationale || "No rationale provided."}</small></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </section>
    </main>
  );
}

export default Dashboard;
