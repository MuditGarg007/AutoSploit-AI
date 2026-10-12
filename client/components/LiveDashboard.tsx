// Live-by-design section. Copy on the left, a static snapshot of the real
// dashboard on the right: a tool-call feed, phase, finding count, cost meter.
// A styled still of the actual UI, not an invented terminal transcript.

import Section from "@/components/Section";

const FEED: { tool: string; note: string; hit?: boolean }[] = [
  { tool: "http.probe", note: "GET /rest/products  200" },
  { tool: "sqli.test", note: "' OR 1=1 --  reflected", hit: true },
  { tool: "auth.jwt", note: "forged admin token  accepted", hit: true },
  { tool: "order.inject", note: "negative quantity  accepted", hit: true },
  { tool: "report.write", note: "3 findings  2 critical" },
];

export default function LiveDashboard() {
  return (
    <Section id="live" eyebrow="live by design">
      <div className="grid gap-14 lg:grid-cols-2 lg:items-center">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-text sm:text-5xl">
            Watch every move as it happens.
          </h2>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted">
            The attack engine streams a live feed of what it&apos;s doing — the
            phase it&apos;s in, every tool call it makes, each finding the moment
            it lands, and exactly what the run is costing you. You&apos;re never
            staring at a spinner waiting for a PDF. You watch it work.
          </p>
        </div>

        {/* dashboard snapshot */}
        <div
          className="overflow-hidden rounded-xl border border-white/10 bg-surface"
          style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <span className="font-mono text-xs text-faint">eng-7f3a</span>
            <span className="flex items-center gap-2 font-mono text-xs text-accent-bright">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" />
              exploit
            </span>
          </div>

          {/* stat row */}
          <div className="grid grid-cols-3 divide-x divide-white/10 border-b border-white/10">
            {[
              ["findings", "3"],
              ["critical", "2"],
              ["spend", "$0.41"],
            ].map(([label, value]) => (
              <div key={label} className="px-5 py-4">
                <div className="text-xl font-semibold tracking-tight text-text">
                  {value}
                </div>
                <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-faint">
                  {label}
                </div>
              </div>
            ))}
          </div>

          {/* tool-call feed */}
          <ul className="px-5 py-4 font-mono text-[13px] leading-relaxed">
            {FEED.map((row, i) => (
              <li key={i} className="flex items-baseline gap-3 py-1">
                <span
                  className={
                    row.hit ? "text-accent-bright" : "text-muted"
                  }
                >
                  {row.tool}
                </span>
                <span className="truncate text-faint">{row.note}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
