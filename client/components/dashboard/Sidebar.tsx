"use client";

// Persistent left rail for the dashboard. Brand at the top, one burgundy primary
// action, then the engagement list (recent runs, like a chat history), and a
// user card pinned to the bottom. Flat black, hairline right border, line icons
// only (design rules). Active state is derived from the path, marked with a thin
// accent bar and a raised surface, not a colored dot.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/format";
import { listEngagements } from "@/lib/api";
import type { EngagementRow } from "@/lib/mock-engagements";
import {
  ChevronRightIcon,
  GridIcon,
  LogOutIcon,
  PlusIcon,
  UserIcon,
} from "./icons";
import { useNewEngagement } from "./NewEngagementPanel";

// All-engagements index link. The run list below leads into individual runs; this
// is the one top-level nav entry that survives from the old grouped nav.
function IndexLink({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = pathname === "/dashboard";
  return (
    <Link
      href="/dashboard"
      onClick={onNavigate}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors",
        active
          ? "bg-surface-2 text-text"
          : "text-muted hover:bg-white/5 hover:text-text",
      )}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-bright" />
      )}
      <GridIcon
        className={cn(active ? "text-text" : "text-faint group-hover:text-muted")}
      />
      <span>Overview</span>
    </Link>
  );
}

// One run in the history list. Repo name only, truncated; the current run gets
// the accent bar + raised surface, matching the index link.
function RunLink({
  row,
  active,
  onNavigate,
}: {
  row: EngagementRow;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={`/dashboard/${row.id}`}
      onClick={onNavigate}
      title={row.repo}
      className={cn(
        "group relative flex h-9 items-center rounded-md px-3 text-sm transition-colors",
        active
          ? "bg-surface-2 text-text"
          : "text-muted hover:bg-white/5 hover:text-text",
      )}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-bright" />
      )}
      <span className="truncate">{row.repo}</span>
    </Link>
  );
}

// Bottom user card: avatar + GitHub login, opening a small popover with sign
// out. The user loads client-side from the control plane (useAuth); a quiet
// skeleton holds the row height until it resolves. The menu closes on outside
// click, Escape, or selecting an item.
function UserCard() {
  const { user: activeUser, status, signOut } = useAuth();
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
    return (
      <div className="flex items-center gap-3 px-2 py-1.5">
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-2" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-2.5 w-2/3 animate-pulse rounded bg-surface-2" />
          <div className="h-2 w-5/6 animate-pulse rounded bg-surface-2" />
        </div>
      </div>
    );
  }

  if (!activeUser) return null;

  const name = activeUser.githubLogin;

  return (
    <div ref={ref} className="relative">
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-md border border-white/10 bg-surface shadow-lg shadow-black/40"
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

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5",
          open && "bg-white/5",
        )}
      >
        {activeUser.avatarUrl ? (
          // GitHub-hosted avatar; a plain img avoids a next/image remote-pattern
          // config for the GitHub avatar CDN.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={activeUser.avatarUrl}
            alt=""
            className="h-8 w-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2">
            <UserIcon size={15} className="text-muted" />
          </div>
        )}

        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium text-text">{name}</p>
        </div>

        <ChevronRightIcon
          size={16}
          className={cn(
            "shrink-0 text-faint transition-transform",
            open ? "-rotate-90" : "rotate-0",
          )}
        />
      </button>
    </div>
  );
}

export default function Sidebar({
  open = false,
  onNavigate,
}: {
  open?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? "/dashboard";
  const [rows, setRows] = useState<EngagementRow[]>([]);
  const openNewEngagement = useNewEngagement();

  // Pull the run list client-side (listEngagements is isomorphic and falls back
  // to mock). Re-run on path change so a newly dispatched run shows up once its
  // page loads, without a manual refresh.
  useEffect(() => {
    let alive = true;
    listEngagements()
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => {
        /* keep the last list on a transient failure */
      });
    return () => {
      alive = false;
    };
  }, [pathname]);

  return (
    <aside
      className={cn(
        // Fixed rail on desktop; slide-in drawer below lg. z-50 keeps it above
        // the z-40 backdrop. transition-transform is motion the reduced-motion
        // media query in globals neutralizes.
        "fixed inset-y-0 left-0 z-50 flex w-60 flex-col bg-canvas transition-transform duration-200 lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
      {/* brand. No borders here so the top row reads seamless with the top bar */}
      <div className="flex h-14 items-center px-5">
        <Link href="/" onClick={onNavigate} aria-label="AutoSploit AI">
          <Image
            src="/logo.png"
            alt="AutoSploit AI"
            width={1323}
            height={213}
            priority
            className="h-6 w-auto"
          />
        </Link>
      </div>

      {/* primary action */}
      <div className="border-r border-white/10 px-3 pt-4">
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            openNewEngagement();
          }}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
        >
          <PlusIcon size={15} />
          New engagement
        </button>
      </div>

      {/* nav: index link + run history */}
      <nav className="flex-1 overflow-y-auto border-r border-white/10 px-3 py-4">
        <IndexLink pathname={pathname} onNavigate={onNavigate} />

        <p className="px-3 pb-2 pt-6 font-mono text-[10px] uppercase tracking-widest text-faint">
          Engagements
        </p>
        <div className="flex flex-col gap-0.5">
          {rows.length === 0 ? (
            <p className="px-3 py-1 text-xs text-faint">No runs yet.</p>
          ) : (
            rows.map((row) => (
              <RunLink
                key={row.id}
                row={row}
                active={pathname === `/dashboard/${row.id}`}
                onNavigate={onNavigate}
              />
            ))
          )}
        </div>
      </nav>

      {/* user */}
      <div className="border-r border-t border-white/10 p-3">
        <UserCard />
      </div>
    </aside>
  );
}
