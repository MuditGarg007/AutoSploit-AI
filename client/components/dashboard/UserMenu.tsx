"use client";

// Top-bar user control: the signed-in GitHub avatar as a button that opens a
// small popover with sign out. Lifted out of the old sidebar user card so the
// dashboard nav and the engagement cockpit bar can share one identity control.
// No status dot, hairline-bordered popover, closes on outside click / Escape /
// selection (design rules).

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/format";
import { LogOutIcon, UserIcon } from "./icons";

export default function UserMenu() {
  const { user, status, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (status === "loading") {
    return <div className="h-8 w-8 animate-pulse rounded-full bg-surface-2" />;
  }
  if (!user) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.githubLogin}
        className={cn(
          "flex h-9 items-center gap-2 rounded-md pl-1 pr-2 transition-colors hover:bg-white/5",
          open && "bg-white/5",
        )}
      >
        {user.avatarUrl ? (
          // GitHub-hosted avatar; a plain img avoids a next/image remote-pattern
          // config for the GitHub avatar CDN.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
            alt=""
            className="h-7 w-7 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2">
            <UserIcon size={14} className="text-muted" />
          </span>
        )}
        <span className="hidden max-w-[10rem] truncate text-sm font-medium text-text sm:inline">
          {user.githubLogin}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-md border border-white/10 bg-surface shadow-lg shadow-black/40"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-3 px-3 py-2 text-sm text-accent-bright transition-colors hover:bg-accent-soft"
          >
            <LogOutIcon size={16} className="text-accent-bright" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
