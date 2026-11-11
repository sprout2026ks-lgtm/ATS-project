import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  linkWithPhoneNumber,
  onAuthStateChanged,
  RecaptchaVerifier,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signOut,
  updateProfile,
} from "firebase/auth";
import { auth, firebaseConfigured } from "./firebase.js";
import { saveProfile } from "./api.js";
import Dashboard from "./Dashboard.jsx";

const authErrorMessages = {
  "auth/email-already-in-use": "An account already exists for this email.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/invalid-phone-number": "Enter a phone number with its country code.",
  "auth/invalid-credential": "The email or password is incorrect.",
  "auth/operation-not-allowed":
    "Firebase rejected phone sign-in. Verify this web app's API key and App ID in Project settings, and check Authentication → Settings → SMS region policy allows your number's country.",
  "auth/invalid-verification-code": "That verification code is incorrect.",
  "auth/credential-already-in-use": "That phone number is linked to another account.",
  "auth/too-many-requests":
    "Firebase has temporarily limited phone verification. For a test number, confirm it matches the number configured in the same Firebase project exactly (including country code), then enter its configured test code; no SMS is sent. For a real number, stop retrying and wait before trying again.",
  "auth/user-not-found": "The email or password is incorrect.",
  "auth/weak-password": "Choose a password with at least 6 characters.",
};

function readableError(error) {
  return authErrorMessages[error.code] || error.message || "Something went wrong.";
}

function App() {
  const [mode, setMode] = useState("signin");
  const [authUser, setAuthUser] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [pendingRegistration, setPendingRegistration] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(
    () => {
      if (!auth) return undefined;
      return onAuthStateChanged(auth, (user) => {
        setAuthUser(user);
        if (
          user &&
          !user.phoneNumber &&
          user.providerData.some((provider) => provider.providerId === "password")
        ) {
          setPendingRegistration(true);
          setMode("phone-setup");
        }
      });
    },
    [],
  );

  function getRecaptchaVerifier() {
    if (!window.atsRecaptchaVerifier) {
      window.atsRecaptchaVerifier = new RecaptchaVerifier(
        auth,
        "recaptcha-container",
        { size: "invisible" },
      );
    }
    return window.atsRecaptchaVerifier;
  }

  async function sendPhoneCode(user = null) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const verifier = getRecaptchaVerifier();
      const result = user
        ? await linkWithPhoneNumber(user, phone.trim(), verifier)
        : await signInWithPhoneNumber(auth, phone.trim(), verifier);
      setConfirmation(result);
      setNotice("A verification code has been sent to your phone.");
    } catch (sendError) {
      setError(readableError(sendError));
    } finally {
      setBusy(false);
    }
  }

  async function finishEmailRegistration(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
      await updateProfile(result.user, { displayName: displayName.trim() });
      setPendingRegistration(true);
      setMode("phone-setup");
      await sendPhoneCode(result.user);
    } catch (registrationError) {
      setError(readableError(registrationError));
    } finally {
      setBusy(false);
    }
  }

  async function finishEmailSignIn(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await signInWithEmailAndPassword(auth, email.trim(), password);
      if (result.user.phoneNumber) {
        await saveProfile(result.user, result.user.displayName || email.trim());
        setNotice("You are signed in.");
      } else {
        setPendingRegistration(true);
        setMode("phone-setup");
      }
    } catch (signInError) {
      setError(readableError(signInError));
    } finally {
      setBusy(false);
    }
  }

  async function finishPhoneSignIn(event) {
    event.preventDefault();
    if (!confirmation) {
      await sendPhoneCode();
      return;
    }

    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await confirmation.confirm(code.trim());
      const hasEmailPassword = result.user.providerData.some(
        (provider) => provider.providerId === "password",
      );
      if (!result.user.email || !hasEmailPassword) {
        await signOut(auth);
        throw new Error("This phone number is not linked to a registered email account.");
      }
      await saveProfile(result.user, result.user.displayName || result.user.email);
      setConfirmation(null);
      setCode("");
      setNotice("You are signed in.");
    } catch (verificationError) {
      setError(readableError(verificationError));
    } finally {
      setBusy(false);
    }
  }

  async function finishPhoneRegistration(event) {
    event.preventDefault();
    if (!confirmation) {
      await sendPhoneCode(auth.currentUser);
      return;
    }

    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await confirmation.confirm(code.trim());
      setAuthUser(result.user);
      setPendingRegistration(false);
      setConfirmation(null);
      setCode("");
      await saveProfile(
        result.user,
        displayName.trim() || result.user.displayName || result.user.email || "ATS user",
      );
      setNotice("Your account is ready.");
    } catch (verificationError) {
      setError(readableError(verificationError));
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setNotice("If an account exists for that email, a password reset link is on its way.");
    } catch (resetError) {
      if (["auth/user-not-found", "auth/user-disabled", "auth/email-not-found"].includes(resetError.code)) {
        setNotice("If an account exists for that email, a password reset link is on its way.");
      } else {
        setError(readableError(resetError));
      }
    } finally {
      setBusy(false);
    }
  }

  async function leavePhoneSetup() {
    setError("");
    setBusy(true);
    try {
      await signOut(auth);
      setPendingRegistration(false);
      setConfirmation(null);
      setCode("");
      setMode("signin");
      setNotice("Sign in after verifying the phone number linked to your account.");
    } catch (signOutError) {
      setError(readableError(signOutError));
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setError("");
    setNotice("");
    try {
      await signOut(auth);
      setMode("signin");
    } catch (signOutError) {
      setError(readableError(signOutError));
    }
  }

  function changeMode(nextMode) {
    setError("");
    setNotice("");
    setConfirmation(null);
    setCode("");
    setMode(nextMode);
  }

  const phoneSetup = mode === "phone-setup" && pendingRegistration && authUser;

  if (authUser && !phoneSetup) {
    return <Dashboard authUser={authUser} onSignOut={handleSignOut} />;
  }

  return (
    <main className="page-shell">
      <section className="auth-card" aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true">A</div>
        <p className="eyebrow">ATS PROJECT</p>
        <h1 id="page-title">
          {authUser && !phoneSetup
            ? "Welcome back"
            : phoneSetup
              ? "Verify your phone"
              : mode === "signup"
                ? "Create your account"
                : mode === "reset"
                  ? "Reset your password"
                  : mode === "phone"
                    ? "Sign in with phone"
                    : "Sign in"}
        </h1>
        <p className="subtitle">
          {phoneSetup
            ? "Add a verified phone number for secure sign-in."
            : authUser
              ? authUser.email || authUser.phoneNumber
              : "Access your account securely."}
        </p>

        {!firebaseConfigured && (
          <p className="message setup-message" role="status">
            Firebase is not configured yet. Copy <code>frontend/.env.example</code> to{" "}
            <code>frontend/.env</code>, enter your Firebase web app settings, then restart
            the frontend server.
          </p>
        )}

        {authUser && !phoneSetup ? (
          <div className="signed-in-panel">
            <p>You are signed in as <strong>{authUser.email || authUser.phoneNumber}</strong>.</p>
            {error && <p className="message error-message" role="alert">{error}</p>}
            {notice && <p className="message success-message" role="status">{notice}</p>}
            <button className="primary-button" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        ) : phoneSetup ? (
          <form onSubmit={finishPhoneRegistration} className="auth-form">
            <label htmlFor="phone">Mobile number</label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+15551234567"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
            {confirmation && (
              <>
                <label htmlFor="code">Verification code</label>
                <input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="Enter the SMS code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </>
            )}
            {error && <p className="message error-message" role="alert">{error}</p>}
            {notice && <p className="message success-message" role="status">{notice}</p>}
            <button className="primary-button" type="submit" disabled={busy || !auth}>
              {busy ? "Please wait..." : confirmation ? "Verify phone" : "Send code"}
            </button>
            <button className="text-button" type="button" onClick={leavePhoneSetup} disabled={busy}>
              Finish later and sign out
            </button>
          </form>
        ) : mode === "signup" ? (
          <form onSubmit={finishEmailRegistration} className="auth-form">
            <label htmlFor="name">Full name</label>
            <input
              id="name"
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength="6"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error && <p className="message error-message" role="alert">{error}</p>}
            <button className="primary-button" type="submit" disabled={busy || !auth}>
              {busy ? "Please wait..." : "Continue"}
            </button>
          </form>
        ) : mode === "reset" ? (
          <form onSubmit={requestPasswordReset} className="auth-form">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <p className="helper-text">
              We’ll email a secure link to reset your password.
            </p>
            {error && <p className="message error-message" role="alert">{error}</p>}
            {notice && <p className="message success-message" role="status">{notice}</p>}
            <button className="primary-button" type="submit" disabled={busy || !auth}>
              {busy ? "Sending..." : "Send reset link"}
            </button>
            <button className="text-button" type="button" onClick={() => changeMode("signin")}>
              Back to sign in
            </button>
          </form>
        ) : mode === "phone" ? (
          <form onSubmit={finishPhoneSignIn} className="auth-form">
            <label htmlFor="phone">Mobile number</label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+15551234567"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
            {confirmation && (
              <>
                <label htmlFor="code">Verification code</label>
                <input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="Enter the SMS code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </>
            )}
            {error && <p className="message error-message" role="alert">{error}</p>}
            {notice && <p className="message success-message" role="status">{notice}</p>}
            <button className="primary-button" type="submit" disabled={busy || !auth}>
              {busy ? "Please wait..." : confirmation ? "Verify and sign in" : "Send code"}
            </button>
            <button className="text-button" type="button" onClick={() => changeMode("signin")}>
              Back to email sign in
            </button>
          </form>
        ) : (
          <form onSubmit={finishEmailSignIn} className="auth-form">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error && <p className="message error-message" role="alert">{error}</p>}
            {notice && <p className="message success-message" role="status">{notice}</p>}
            <button className="primary-button" type="submit" disabled={busy || !auth}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
            <div className="form-links">
              <button className="text-button" type="button" onClick={() => changeMode("reset")}>
                Forgot password?
              </button>
              <button className="text-button" type="button" onClick={() => changeMode("phone")}>
                Use phone instead
              </button>
            </div>
          </form>
        )}

        {!authUser && !phoneSetup && mode === "signin" && (
          <p className="switch-mode">
            New to ATS?{" "}
            <button className="text-button inline-button" type="button" onClick={() => changeMode("signup")}>
              Create an account
            </button>
          </p>
        )}
        {!authUser && !phoneSetup && mode === "signup" && (
          <p className="switch-mode">
            Already have an account?{" "}
            <button className="text-button inline-button" type="button" onClick={() => changeMode("signin")}>
              Sign in
            </button>
          </p>
        )}
        <div id="recaptcha-container" />
      </section>
      <footer>Secure access to your ATS workspace</footer>
    </main>
  );
}

export default App;
