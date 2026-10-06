// Slim top bar for the dashboard shell. A quiet search field on the left and the
// session controls on the right. Flat black, one hairline bottom border, no
// blur, no gradient. The search is a visual affordance for now; wiring it to the
// command palette is a later pass, so it is a plain styled control.

import { Show } from "@clerk/nextjs";
import Link from "next/link";
import { SearchIcon, MenuIcon } from "./icons";

export default function Topbar({ onMenu }: { onMenu?: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-white/10 bg-canvas/95 px-4 backdrop-blur-[2px] sm:px-6">
      {/* Opens the nav drawer on mobile; the fixed rail makes it redundant on lg. */}
      <button
        type="button"
        aria-label="Open navigation"
        onClick={onMenu}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-text lg:hidden"
      >
        <MenuIcon size={18} />
      </button>

      {/* Placeholder search. Hidden on the narrowest screens to keep the bar
          uncluttered next to the menu button. */}
      <div className="mx-auto hidden w-full max-w-md sm:block">
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-md border border-white/10 bg-surface px-3 text-sm text-faint transition-colors hover:border-border-strong"
        >
          <SearchIcon size={15} />
          <span>Search engagements</span>
          <span className="ml-auto font-mono text-[10px] text-faint">⌘K</span>
        </button>
      </div>

      {/* Sign out now lives in the sidebar user card. Only the signed-out log-in
          affordance remains here. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Show when="signed-out">
          <Link
            href="/login"
            className="flex h-9 items-center rounded-md px-3 text-sm text-muted transition-colors hover:bg-white/5 hover:text-text"
          >
            Log in
          </Link>
        </Show>
      </div>
    </header>
  );
}
