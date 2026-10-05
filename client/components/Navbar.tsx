"use client";

// Top navbar. Full-width sticky bar, single burgundy accent.
// Transparent over the hero; liquid-glass surface fades in on scroll.

import Link from "next/link";
import { useEffect, useState } from "react";
// Core 3 removed <SignedIn>/<SignedOut>; the replacement is <Show when=...>.
import { Show, SignOutButton } from "@clerk/nextjs";

const LINKS = [
  { label: "Platform", href: "#platform" },
  { label: "How it works", href: "#flow" },
  { label: "Docs", href: "#docs" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 w-full transition-colors duration-300 ${
        scrolled
          ? "bg-black/40 backdrop-blur-xl backdrop-saturate-150"
          : "bg-transparent"
      }`}
    >
      <nav className="mx-auto flex w-full max-w-7xl items-center gap-2 px-4 py-3 sm:px-6">
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
        <div className="ml-auto" />
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
    </header>
  );
}
