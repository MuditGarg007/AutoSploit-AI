// Login / signup screen. Right half: full-height image. Left half: auth panel
// with social options first, then email. Wired to Clerk: Google and GitHub via
// OAuth redirect, email + password via Clerk's sign-in / sign-up flows. Sign-up
// confirms ownership with an emailed code before the session is created.
"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
// Classic resource-based hooks. Clerk v7 (Core 3) moved these to the /legacy
// subpath; the default @clerk/nextjs export is now the new signals API.
import { useSignIn, useSignUp } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";

const ACCENT_GRADIENT =
  "linear-gradient(120deg, var(--accent-bright) 0%, var(--accent-purple) 100%)";

const IMAGE_URL = "/login-bg.jpg";

type OAuthStrategy = "oauth_google" | "oauth_github";

function firstClerkError(err: unknown): string {
  if (isClerkAPIResponseError(err)) {
    return (
      err.errors[0]?.longMessage ??
      err.errors[0]?.message ??
      "Something went wrong. Try again."
    );
  }
  return "Something went wrong. Try again.";
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.29 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}

function GithubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 1C5.92 1 1 5.92 1 12c0 4.86 3.15 8.98 7.52 10.44.55.1.75-.24.75-.53v-1.86c-3.06.66-3.71-1.48-3.71-1.48-.5-1.27-1.22-1.61-1.22-1.61-1-.68.08-.67.08-.67 1.1.08 1.68 1.13 1.68 1.13.98 1.68 2.57 1.2 3.2.92.1-.71.38-1.2.7-1.47-2.44-.28-5.01-1.22-5.01-5.44 0-1.2.43-2.18 1.13-2.95-.11-.28-.49-1.4.11-2.91 0 0 .92-.3 3.02 1.13a10.5 10.5 0 0 1 5.5 0c2.1-1.43 3.02-1.13 3.02-1.13.6 1.51.22 2.63.11 2.91.7.77 1.13 1.75 1.13 2.95 0 4.23-2.58 5.15-5.03 5.43.4.34.75 1.01.75 2.04v3.02c0 .3.2.64.76.53A11.01 11.01 0 0 0 23 12c0-6.08-4.92-11-11-11Z" />
    </svg>
  );
}

function LoginPanel() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } =
    useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } =
    useSignUp();

  const [mode, setMode] = useState<"login" | "signup">(
    searchParams.get("mode") === "signup" ? "signup" : "login",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLogin = mode === "login";
  const ready = signInLoaded && signUpLoaded;

  function switchMode() {
    setMode(isLogin ? "signup" : "login");
    setError(null);
    setPendingVerification(false);
    setCode("");
  }

  async function handleOAuth(strategy: OAuthStrategy) {
    if (!ready || busy) return;
    setError(null);
    setBusy(true);
    try {
      const flow = isLogin ? signIn : signUp;
      await flow.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/dashboard",
      });
      // Redirects away; nothing after this runs on success.
    } catch (err) {
      setError(firstClerkError(err));
      setBusy(false);
    }
  }

  async function handleLogin() {
    if (!signInLoaded) return;
    const res = await signIn.create({ identifier: email, password });
    if (res.status === "complete") {
      await setSignInActive({ session: res.createdSessionId });
      router.push("/dashboard");
    } else {
      // Additional factors (e.g. 2FA) are not wired into this UI yet.
      setError("Additional verification is required to sign in.");
    }
  }

  async function handleSignup() {
    if (!signUpLoaded) return;
    await signUp.create({ emailAddress: email, password });
    await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    setPendingVerification(true);
  }

  async function handleVerify() {
    if (!signUpLoaded) return;
    const res = await signUp.attemptEmailAddressVerification({ code });
    if (res.status === "complete") {
      await setSignUpActive({ session: res.createdSessionId });
      router.push("/dashboard");
    } else {
      setError("That code did not verify. Check it and try again.");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (pendingVerification) {
        await handleVerify();
      } else if (isLogin) {
        await handleLogin();
      } else {
        await handleSignup();
      }
    } catch (err) {
      setError(firstClerkError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-screen flex-1 lg:flex-row-reverse">
      <Link
        href="/"
        className="absolute left-6 top-6 z-10 flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-border-strong hover:text-text active:scale-[0.99]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to home
      </Link>

      {/* right: full-height image, hidden on small screens */}
      <div className="relative hidden w-2/5 lg:block">
        <img
          src={IMAGE_URL}
          alt=""
          className="h-full w-full object-cover"
        />
        {/* burgundy wash to seat the image in the theme */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(6,1,4,0.35) 0%, rgba(6,1,4,0.55) 60%, rgba(0,0,0,0.85) 100%)",
          }}
        />
        <div className="absolute inset-x-0 bottom-0 p-10">
          <span className="font-mono text-xs uppercase tracking-widest text-faint">
            autonomous red-team · self-hosted
          </span>
        </div>
      </div>

      {/* left: auth panel */}
      <div className="flex w-full flex-col justify-center px-6 lg:w-3/5 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <Image
            src="/logo.png"
            alt="AutoSploit AI"
            width={1323}
            height={213}
            priority
            className="h-7 w-auto"
          />

          {pendingVerification ? (
            <>
              <h1 className="mt-8 text-2xl font-semibold tracking-tight text-text">
                Check your email
              </h1>
              <p className="mt-2 text-sm text-muted">
                We sent a code to {email}. Enter it to finish creating your
                account.
              </p>

              {error ? (
                <p className="mt-6 text-sm text-accent-bright">{error}</p>
              ) : null}

              <form className="mt-8 flex flex-col gap-4" onSubmit={onSubmit}>
                <label className="flex flex-col gap-2">
                  <span className="font-mono text-xs uppercase tracking-widest text-faint">
                    Verification code
                  </span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    className="h-11 rounded-md border border-border bg-surface px-3 text-sm tracking-[0.3em] text-text placeholder:text-faint outline-none transition-colors focus:border-accent-bright"
                  />
                </label>

                <button
                  type="submit"
                  disabled={busy || !code}
                  className="mt-2 h-11 rounded-md text-sm font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
                  style={{
                    background: ACCENT_GRADIENT,
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
                  }}
                >
                  {busy ? "Verifying…" : "Verify and continue"}
                </button>
              </form>

              <p className="mt-8 text-center text-sm text-muted">
                Wrong address?{" "}
                <button
                  type="button"
                  onClick={switchMode}
                  className="font-medium text-text transition-colors hover:text-accent-bright"
                >
                  Start over
                </button>
              </p>
            </>
          ) : (
            <>
              <h1 className="mt-8 text-2xl font-semibold tracking-tight text-text">
                {isLogin ? "Welcome back" : "Create your account"}
              </h1>
              <p className="mt-2 text-sm text-muted">
                {isLogin
                  ? "Sign in to pick up your engagements."
                  : "Start running isolated engagements in minutes."}
              </p>

              {error ? (
                <p className="mt-6 text-sm text-accent-bright">{error}</p>
              ) : null}

              {/* social first */}
              <div className="mt-8 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => handleOAuth("oauth_google")}
                  disabled={!ready || busy}
                  className="flex h-11 items-center justify-center gap-3 rounded-md border border-border-strong bg-surface text-sm font-medium text-text transition-colors hover:bg-surface-2 active:scale-[0.99] disabled:opacity-60"
                >
                  <GoogleMark />
                  Continue with Google
                </button>
                <button
                  type="button"
                  onClick={() => handleOAuth("oauth_github")}
                  disabled={!ready || busy}
                  className="flex h-11 items-center justify-center gap-3 rounded-md border border-border-strong bg-surface text-sm font-medium text-text transition-colors hover:bg-surface-2 active:scale-[0.99] disabled:opacity-60"
                >
                  <GithubMark />
                  Continue with GitHub
                </button>
              </div>

              {/* divider */}
              <div className="my-6 flex items-center gap-4">
                <span className="h-px flex-1 bg-border" />
                <span className="font-mono text-xs uppercase tracking-widest text-faint">
                  or
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>

              {/* email */}
              <form className="flex flex-col gap-4" onSubmit={onSubmit}>
                <label className="flex flex-col gap-2">
                  <span className="font-mono text-xs uppercase tracking-widest text-faint">
                    Email
                  </span>
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="h-11 rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-faint outline-none transition-colors focus:border-accent-bright"
                    style={{ boxShadow: "none" }}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="font-mono text-xs uppercase tracking-widest text-faint">
                    Password
                  </span>
                  <input
                    type="password"
                    autoComplete={isLogin ? "current-password" : "new-password"}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="h-11 rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-faint outline-none transition-colors focus:border-accent-bright"
                  />
                </label>

                {isLogin ? (
                  <div className="-mt-1 flex justify-end">
                    <a
                      href="#reset"
                      className="text-xs text-muted transition-colors hover:text-text"
                    >
                      Forgot password?
                    </a>
                  </div>
                ) : null}

                {/* Clerk bot-protection widget mounts here for sign-up. */}
                <div id="clerk-captcha" />

                <button
                  type="submit"
                  disabled={!ready || busy}
                  className="mt-2 h-11 rounded-md text-sm font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
                  style={{
                    background: ACCENT_GRADIENT,
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
                  }}
                >
                  {busy
                    ? isLogin
                      ? "Signing in…"
                      : "Creating account…"
                    : isLogin
                      ? "Sign in"
                      : "Create account"}
                </button>
              </form>

              {/* mode switch */}
              <p className="mt-8 text-center text-sm text-muted">
                {isLogin ? "New here? " : "Already have an account? "}
                <button
                  type="button"
                  onClick={switchMode}
                  className="font-medium text-text transition-colors hover:text-accent-bright"
                >
                  {isLogin ? "Create an account" : "Sign in"}
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary during prerender (Next 16).
  return (
    <Suspense>
      <LoginPanel />
    </Suspense>
  );
}
