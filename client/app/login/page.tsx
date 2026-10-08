// Standalone sign-in route. On the landing page sign-in happens in the
// SignInModal overlay; this page is the direct /login target (DashboardShell
// redirects signed-out users here). It centers the same SignInCard on true
// black, so the GitHub hand-off stays defined in one place.

import Link from "next/link";

import SignInCard from "@/components/SignInCard";

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <Link
        href="/"
        className="absolute left-6 top-6 flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:border-border-strong hover:text-text active:scale-[0.99]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to home
      </Link>

      <SignInCard />
    </main>
  );
}
