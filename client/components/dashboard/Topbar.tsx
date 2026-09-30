// Slim top bar for the dashboard shell. A quiet search field on the left and the
// session controls on the right. Flat black, one hairline bottom border, no
// blur, no gradient. The search is a visual affordance for now; wiring it to the
// command palette is a later pass, so it is a plain styled control.

import { Show, SignOutButton } from "@clerk/nextjs";
import Link from "next/link";
import { SearchIcon } from "./icons";

export default function Topbar() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center border-b border-white/10 bg-canvas/95 px-6 backdrop-blur-[2px]">
      <div className="mx-auto w-full max-w-md">
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-md border border-white/10 bg-surface px-3 text-sm text-faint transition-colors hover:border-border-strong"
        >
          <SearchIcon size={15} />
          <span>Search engagements</span>
          <span className="ml-auto font-mono text-[10px] text-faint">⌘K</span>
        </button>
      </div>

      <div className="absolute right-6 flex items-center gap-2">
        <Show when="signed-out">
          <Link
            href="/login"
            className="flex h-9 items-center rounded-md px-3 text-sm text-muted transition-colors hover:bg-white/5 hover:text-text"
          >
            Log in
          </Link>
        </Show>
        <Show when="signed-in">
          <SignOutButton redirectUrl="/">
            <button
              type="button"
              className="flex h-9 items-center rounded-md px-3 text-sm text-muted transition-colors hover:bg-white/5 hover:text-text active:scale-[0.99]"
            >
              Sign out
            </button>
          </SignOutButton>
        </Show>
      </div>
    </header>
  );
}
