// Sign-in screen. Right half: full-height image. Left half: auth panel. The
// control plane owns identity through GitHub OAuth, so this is a single
// "Continue with GitHub" action that hands off to the backend's /auth/github;
// the backend runs the handshake and redirects to /dashboard with the session.
// When no backend is configured (mock/demo build) the button goes straight to
// the dashboard, which renders on mock data.
"use client";

import { Suspense } from "react";
import Link from "next/link";
import Image from "next/image";
import { hasBackend, signInUrl } from "@/lib/auth";

const ACCENT_GRADIENT =
  "linear-gradient(120deg, var(--accent-bright) 0%, var(--accent-purple) 100%)";

const IMAGE_URL = "/login-bg.jpg";

function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 1C5.92 1 1 5.92 1 12c0 4.86 3.15 8.98 7.52 10.44.55.1.75-.24.75-.53v-1.86c-3.06.66-3.71-1.48-3.71-1.48-.5-1.27-1.22-1.61-1.22-1.61-1-.68.08-.67.08-.67 1.1.08 1.68 1.13 1.68 1.13.98 1.68 2.57 1.2 3.2.92.1-.71.38-1.2.7-1.47-2.44-.28-5.01-1.22-5.01-5.44 0-1.2.43-2.18 1.13-2.95-.11-.28-.49-1.4.11-2.91 0 0 .92-.3 3.02 1.13a10.5 10.5 0 0 1 5.5 0c2.1-1.43 3.02-1.13 3.02-1.13.6 1.51.22 2.63.11 2.91.7.77 1.13 1.75 1.13 2.95 0 4.23-2.58 5.15-5.03 5.43.4.34.75 1.01.75 2.04v3.02c0 .3.2.64.76.53A11.01 11.01 0 0 0 23 12c0-6.08-4.92-11-11-11Z" />
    </svg>
  );
}

function LoginPanel() {
  // With a backend configured, hand off to its GitHub OAuth; otherwise the demo
  // build has no auth, so go straight to the (mock-backed) dashboard.
  const href = hasBackend() ? signInUrl() : "/dashboard";

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
        <img src={IMAGE_URL} alt="" className="h-full w-full object-cover" />
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

          <h1 className="mt-8 text-2xl font-semibold tracking-tight text-text">
            Sign in to AutoSploit
          </h1>
          <p className="mt-2 text-sm text-muted">
            Engagements run against your own repositories, so the control plane
            signs you in with GitHub and uses that grant to clone them.
          </p>

          <div className="mt-8 flex flex-col gap-3">
            <a
              href={href}
              className="flex h-11 items-center justify-center gap-3 rounded-md text-sm font-semibold text-white transition-transform active:scale-[0.99]"
              style={{
                background: ACCENT_GRADIENT,
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
              }}
            >
              <GithubMark />
              Continue with GitHub
            </a>
          </div>

          <p className="mt-8 text-center text-xs text-faint">
            By continuing you authorize AutoSploit to read the repositories you
            select for an engagement.
          </p>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPanel />
    </Suspense>
  );
}
