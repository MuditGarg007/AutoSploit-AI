// The sign-in card: the "Sign in" heading and the single "Continue with GitHub"
// action. Shared by the SignInModal overlay on the landing page and the /login
// route (the redirect target for signed-out dashboard users), so the GitHub
// hand-off lives in exactly one place.
//
// With a backend configured the button navigates to its GitHub OAuth entry
// point; the demo build has no auth, so it goes straight to the mock dashboard.

import { hasBackend, signInUrl } from "@/lib/token";

function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 1C5.92 1 1 5.92 1 12c0 4.86 3.15 8.98 7.52 10.44.55.1.75-.24.75-.53v-1.86c-3.06.66-3.71-1.48-3.71-1.48-.5-1.27-1.22-1.61-1.22-1.61-1-.68.08-.67.08-.67 1.1.08 1.68 1.13 1.68 1.13.98 1.68 2.57 1.2 3.2.92.1-.71.38-1.2.7-1.47-2.44-.28-5.01-1.22-5.01-5.44 0-1.2.43-2.18 1.13-2.95-.11-.28-.49-1.4.11-2.91 0 0 .92-.3 3.02 1.13a10.5 10.5 0 0 1 5.5 0c2.1-1.43 3.02-1.13 3.02-1.13.6 1.51.22 2.63.11 2.91.7.77 1.13 1.75 1.13 2.95 0 4.23-2.58 5.15-5.03 5.43.4.34.75 1.01.75 2.04v3.02c0 .3.2.64.76.53A11.01 11.01 0 0 0 23 12c0-6.08-4.92-11-11-11Z" />
    </svg>
  );
}

export default function SignInCard({ titleId }: { titleId?: string }) {
  const href = hasBackend() ? signInUrl() : "/dashboard";

  return (
    <div className="w-full max-w-sm">
      <h1
        id={titleId}
        className="text-2xl font-semibold tracking-tight text-text"
      >
        Sign in
      </h1>
      <p className="mt-2 text-sm text-muted">
        Engagements run against your own repositories, so the control plane signs
        you in with GitHub and uses that grant to clone them.
      </p>

      <a
        href={href}
        className="mt-8 flex h-11 items-center justify-center gap-3 rounded-md bg-accent text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
      >
        <GithubMark />
        Continue with GitHub
      </a>

      <p className="mt-8 text-center text-xs text-faint">
        By continuing you authorize AutoSploit to read the repositories you select
        for an engagement.
      </p>
    </div>
  );
}
