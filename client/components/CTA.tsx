// Closing call to action. Solid burgundy button, matching the hero.

import Link from "next/link";

export default function CTA() {
  return (
    <section className="border-t border-white/10 px-6 py-28 sm:py-36">
      <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
        <span className="font-mono text-xs uppercase tracking-widest text-faint">
          self-hosted · your cluster
        </span>
        <h2 className="mt-6 text-4xl font-semibold leading-tight tracking-tight text-text sm:text-6xl">
          Find the way in first.
        </h2>
        <p className="mt-5 max-w-md text-base leading-relaxed text-muted">
          Run your first engagement on infrastructure you control.
        </p>

        <div className="mt-10 flex items-center gap-3">
          <Link
            href="/login?mode=signup"
            className="flex h-11 items-center rounded-md bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.98]"
          >
            Get started
          </Link>
          <a
            href="#docs"
            className="h-11 rounded-md border border-white/10 px-6 text-sm font-medium leading-[2.75rem] text-muted transition-colors hover:border-white/20 hover:text-text"
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}
