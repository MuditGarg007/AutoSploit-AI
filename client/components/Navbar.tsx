// Top navbar. Flat surface pill, hairline border, single burgundy accent.
// No glass, no backdrop blur, no gradient wordmark (design rules).

import Link from "next/link";
// Core 3 removed <SignedIn>/<SignedOut>; the replacement is <Show when=...>.
import { Show, SignOutButton } from "@clerk/nextjs";

const LINKS = [
  { label: "Platform", href: "#platform" },
  { label: "How it works", href: "#flow" },
  { label: "Docs", href: "#docs" },
];

export default function Navbar() {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-5 z-50 flex justify-center px-4">
      <nav className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/10 bg-surface py-2 pl-5 pr-2">
        {/* brand */}
        <span className="mr-2 text-sm font-semibold tracking-tight text-text">
          AutoSploit <span className="text-accent-bright">AI</span>
        </span>

        {/* links */}
        <div className="hidden items-center gap-1 sm:flex">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-text"
            >
              {l.label}
            </a>
          ))}
        </div>

        {/* auth */}
        <Show when="signed-out">
          <Link
            href="/login"
            className="ml-1 flex h-9 items-center rounded-md px-4 text-sm font-medium text-muted transition-colors hover:bg-white/5 hover:text-text"
          >
            Log in
          </Link>
          <Link
            href="/login?mode=signup"
            className="flex h-9 items-center rounded-md bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.98]"
          >
            Sign up
          </Link>
        </Show>
        <Show when="signed-in">
          <Link
            href="/dashboard"
            className="ml-1 flex h-9 items-center rounded-md px-4 text-sm font-medium text-muted transition-colors hover:bg-white/5 hover:text-text"
          >
            Dashboard
          </Link>
          <SignOutButton redirectUrl="/">
            <button
              type="button"
              className="flex h-9 items-center rounded-md px-4 text-sm font-medium text-muted transition-colors hover:bg-white/5 hover:text-text active:scale-[0.98]"
            >
              Sign out
            </button>
          </SignOutButton>
        </Show>
      </nav>
    </div>
  );
}
