"use client";

// Global top nav for the dashboard index, replacing the old left sidebar. A
// slim full-width bar: brand on the left, the primary "New engagement" action
// and the session controls on the right. Flat black, one hairline bottom
// border, no blur toys (design rules). The run history that used to live in the
// sidebar now lives in the page's own run table, so nothing is lost by dropping
// the rail.

import Link from "next/link";
import Image from "next/image";
import { useNewEngagement } from "./NewEngagementPanel";
import UserMenu from "./UserMenu";
import ThemeToggle from "@/components/ThemeToggle";
import { PlusIcon } from "./icons";

export default function DashboardNav() {
  const openNewEngagement = useNewEngagement();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-white/10 bg-canvas/95 px-4 backdrop-blur-[2px] sm:px-6">
      <Link href="/dashboard" aria-label="AutoSploit AI" className="mr-1">
        <Image
          src="/logo.png"
          alt="AutoSploit AI"
          width={1323}
          height={213}
          priority
          className="h-6 w-auto"
        />
      </Link>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={openNewEngagement}
          className="flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
        >
          <PlusIcon size={15} />
          <span className="hidden sm:inline">New engagement</span>
        </button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
