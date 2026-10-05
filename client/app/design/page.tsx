// TEMP design-language reference. Delete this route once the real UI is built.
// Palette: pure-black (AMOLED) canvas, single burgundy accent, cool grays.

const ACCENT = "#8b1e42"; // burgundy, pulled toward purple (wine)

function Swatch({ hex, name, note }: { hex: string; name: string; note: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="h-16 w-full rounded-md border border-white/10"
        style={{ background: hex }}
      />
      <div className="flex items-baseline justify-between font-mono text-xs">
        <span className="text-zinc-300">{name}</span>
        <span className="text-zinc-500">{hex}</span>
      </div>
      <span className="text-xs text-zinc-500">{note}</span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-white/10 py-14">
      <div className="mb-8 flex items-center gap-3">
        <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
          {label}
        </span>
        <span className="h-px flex-1 bg-white/5" />
      </div>
      {children}
    </section>
  );
}

export default function DesignPage() {
  return (
    <div className="min-h-screen bg-black font-sans text-zinc-200 antialiased">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:px-10">
        {/* masthead */}
        <header className="mb-4 flex items-center justify-between">
          {/* No logo/wordmark until a real one is supplied. */}
          <span className="text-sm font-semibold tracking-tight text-white">
            AutoSploit AI
          </span>
          <span className="font-mono text-xs text-zinc-600">design v0</span>
        </header>

        {/* hero: the tone-setter */}
        <div className="mb-6 border-b border-white/10 py-16">
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
            autonomous red-team
          </span>
          <h1 className="mt-6 max-w-2xl text-5xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl">
            Break in before
            <br />
            <span style={{ color: ACCENT }}>they</span> do.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-zinc-400">
            Isolated, disposable engagements. Real exploits, contained in
            gVisor-sandboxed pods. Full teardown on exit. Nothing left running.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <button
              className="h-11 rounded-md px-6 text-sm font-semibold text-white transition-transform active:scale-[0.98]"
              style={{ background: ACCENT }}
            >
              Launch engagement
            </button>
            <button className="h-11 rounded-md border border-white/15 bg-white/[0.03] px-6 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/[0.07]">
              Read the docs
            </button>
          </div>
        </div>

        {/* color */}
        <Row label="Color">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Swatch hex={ACCENT} name="accent" note="CTAs, live state, danger" />
            <Swatch hex="#000000" name="canvas" note="page background (AMOLED)" />
            <Swatch hex="#0e0e0e" name="surface" note="cards, inputs" />
            <Swatch hex="#a1a1aa" name="muted" note="secondary text" />
          </div>
        </Row>

        {/* type */}
        <Row label="Typography">
          <div className="space-y-5">
            <div>
              <p className="text-5xl font-semibold tracking-tight text-white">
                Geist Sans
              </p>
            </div>
            <div>
              <p className="max-w-xl text-lg leading-relaxed text-zinc-400">
                Body copy stays quiet and readable, zinc-400 on near-black, 1.6
                line height. No decorative faces, no gradients on text.
              </p>
            </div>
            <div>
              <p className="font-mono text-sm text-zinc-300">
                $ autosploit run --scope prod --k8s
              </p>
            </div>
          </div>
        </Row>

        {/* buttons */}
        <Row label="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="h-10 rounded-md px-5 text-sm font-semibold text-white"
              style={{ background: ACCENT }}
            >
              Primary
            </button>
            <button className="h-10 rounded-md border border-white/15 bg-white/[0.03] px-5 text-sm font-medium text-zinc-200 hover:bg-white/[0.07]">
              Secondary
            </button>
            <button className="h-10 rounded-md px-5 text-sm font-medium text-zinc-400 hover:text-white">
              Ghost
            </button>
            <button
              className="h-10 rounded-md border px-5 text-sm font-semibold"
              style={{ borderColor: `${ACCENT}55`, color: ACCENT }}
            >
              Danger
            </button>
          </div>
        </Row>

        {/* cards */}
        <Row label="Components">
          <div className="grid gap-4 sm:grid-cols-3">
            {/* stat */}
            <div className="rounded-lg border border-white/10 bg-[#0e0e0e] p-5">
              <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
                findings
              </p>
              <p className="mt-3 text-4xl font-semibold tracking-tight text-white">
                14
              </p>
              <p className="mt-1 text-sm" style={{ color: ACCENT }}>
                3 critical
              </p>
            </div>
            {/* status */}
            <div className="rounded-lg border border-white/10 bg-[#0e0e0e] p-5">
              <span className="text-sm font-medium" style={{ color: ACCENT }}>
                Live
              </span>
              <p className="mt-3 text-sm text-zinc-400">
                engagement <span className="font-mono text-zinc-200">e-8f21</span>
              </p>
              <p className="mt-1 font-mono text-xs text-zinc-500">
                pod running · 04:12 elapsed
              </p>
            </div>
            {/* input */}
            <div className="rounded-lg border border-white/10 bg-[#0e0e0e] p-5">
              <label className="font-mono text-xs uppercase tracking-widest text-zinc-500">
                target
              </label>
              <input
                defaultValue="10.0.4.12/24"
                className="mt-3 w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-[color:var(--accent)]"
                style={{ ["--accent" as string]: ACCENT }}
              />
              <button
                className="mt-3 h-9 w-full rounded-md text-sm font-semibold text-white"
                style={{ background: ACCENT }}
              >
                Scan
              </button>
            </div>
          </div>
        </Row>

        <footer className="border-t border-white/10 py-10 font-mono text-xs text-zinc-600">
          design reference, delete /design before ship
        </footer>
      </div>
    </div>
  );
}
