"use client";

// Persistent left rail for the dashboard. Brand at the top, one burgundy primary
// action, a grouped nav, and a quiet footer. Flat black, hairline right border,
// line icons only (design rules). Active state is derived from the path, marked
// with a thin accent bar and a raised surface, not a colored dot.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/format";
import {
  GridIcon,
  ActivityIcon,
  ShieldIcon,
  BookIcon,
  SettingsIcon,
  PlusIcon,
  ShieldCheckIcon,
} from "./icons";

type NavItem = {
  label: string;
  href: string;
  icon: (p: { className?: string; size?: number }) => React.ReactElement;
  match: (path: string) => boolean;
};

const PRIMARY: NavItem[] = [
  {
    label: "Engagements",
    href: "/dashboard",
    icon: GridIcon,
    match: (p) => p === "/dashboard" || p.startsWith("/dashboard/"),
  },
  {
    label: "Activity",
    href: "/dashboard#activity",
    icon: ActivityIcon,
    match: () => false,
  },
  {
    label: "Scope",
    href: "/dashboard#scope",
    icon: ShieldIcon,
    match: () => false,
  },
];

const SECONDARY: NavItem[] = [
  { label: "Docs", href: "#docs", icon: BookIcon, match: () => false },
  {
    label: "Settings",
    href: "#settings",
    icon: SettingsIcon,
    match: () => false,
  },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
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
      <Icon
        className={cn(active ? "text-text" : "text-faint group-hover:text-muted")}
      />
      <span>{item.label}</span>
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname() ?? "/dashboard";

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-canvas">
      {/* brand. No borders here so the top row reads seamless with the top bar */}
      <div className="flex h-14 items-center px-5">
        <Link href="/" className="text-sm font-semibold tracking-tight text-text">
          AutoSploit <span className="text-accent-bright">AI</span>
        </Link>
      </div>

      {/* primary action */}
      <div className="border-r border-white/10 px-3 pt-4">
        <Link
          href="/dashboard/new"
          className="flex h-9 items-center justify-center gap-2 rounded-md bg-accent text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
        >
          <PlusIcon size={15} />
          New engagement
        </Link>
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto border-r border-white/10 px-3 py-4">
        <p className="px-3 pb-2 font-mono text-[10px] uppercase tracking-widest text-faint">
          Workspace
        </p>
        <div className="flex flex-col gap-0.5">
          {PRIMARY.map((item) => (
            <NavLink
              key={item.label}
              item={item}
              active={item.match(pathname)}
            />
          ))}
        </div>

        <p className="px-3 pb-2 pt-6 font-mono text-[10px] uppercase tracking-widest text-faint">
          More
        </p>
        <div className="flex flex-col gap-0.5">
          {SECONDARY.map((item) => (
            <NavLink key={item.label} item={item} active={false} />
          ))}
        </div>
      </nav>

      {/* footer */}
      <div className="flex items-center gap-2 border-r border-t border-white/10 px-5 py-3">
        <ShieldCheckIcon size={13} className="shrink-0 text-faint" />
        <p className="text-xs text-faint">gVisor sandbox · fail-closed</p>
      </div>
    </aside>
  );
}
