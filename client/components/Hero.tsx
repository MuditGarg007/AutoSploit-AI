// Landing hero. Always dark: MicroSlats burgundy slats on true black with a
// black readability wash, regardless of the app theme. The themed wrapper
// around it (data-theme="dark" in page.tsx) keeps the copy tokens dark too.

import MicroSlats from "@/components/MicroSlats";
import { SignInTrigger } from "@/components/SignInModal";

export default function Hero() {
  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden">
      {/* MicroSlats background, burgundy on true black, behind the hero copy */}
      <div aria-hidden className="absolute inset-0">
        <MicroSlats
          preset="swell"
          backgroundColor="#000000"
          color="#8c1c2b"
          glintColor="#a8283a"
          className="h-full w-full"
          interactive
        />
      </div>

      {/* readability wash over the slats */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(75% 90% at 50% 45%, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.9) 100%)",
        }}
      />

      {/* hero copy */}
      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-6 text-center">
        <span className="font-mono text-xs uppercase tracking-widest text-faint">
          autonomous red-team
        </span>
        <h1 className="mt-6 text-5xl font-semibold leading-[1.02] tracking-tight text-text sm:text-8xl">
          Break in before
          <br />
          they do.
        </h1>
        <p className="mt-7 max-w-md text-lg leading-relaxed text-muted">
          Autonomous engagements that run isolated, then leave no trace.
        </p>

        <SignInTrigger className="mt-10 flex h-11 items-center rounded-md bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.98]">
          Connect GitHub
        </SignInTrigger>
      </div>
    </section>
  );
}
