// OAuth landing route. Google and GitHub redirect the browser back here after
// the provider consent screen. Clerk finishes the handshake, sets the session,
// and forwards to redirectUrlComplete ("/"). Nothing to render but a hint.
"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

export default function SSOCallback() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <span className="font-mono text-xs uppercase tracking-widest text-faint">
        Completing sign in
      </span>
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl="/dashboard"
        signUpFallbackRedirectUrl="/dashboard"
      />
    </main>
  );
}
