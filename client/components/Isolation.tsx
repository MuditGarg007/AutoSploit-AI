// Isolation story + a terminal transcript of a real run. Two columns on desktop.
// The transcript is the "code showcase"; state is shown in plain words, no dots.

import Section from "@/components/Section";

const GUARANTEES = [
  ["gVisor", "Every workload runs in a user-space kernel sandbox, not a shared host kernel."],
  ["default-deny", "NetworkPolicy blocks all egress, then opens only the edge to your target."],
  ["fail-closed", "Namespaces, secrets, and registries are imperative and deny by default."],
  ["exit gate", "Teardown is verified live before an engagement is called done."],
];

const LINES: { prompt?: boolean; text: string; accent?: boolean; dim?: boolean }[] = [
  { prompt: true, text: "autosploit run --scope engagement.yaml --k8s" },
  { text: "provision  namespace eng-7f3a  secrets sealed  registry up" },
  { text: "isolate    gVisor runtimeClass ok  egress default-deny" },
  { text: "exploit    12 targets  4 findings  2 critical", accent: true },
  { text: "teardown   namespace purged  images gc  exit gate ok" },
  { dim: true, text: "engagement eng-7f3a complete in 4m 12s" },
];

export default function Isolation() {
  return (
    <Section id="isolation" eyebrow="containment">
      <div className="grid gap-14 lg:grid-cols-2 lg:items-center">
        <div>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight text-text sm:text-5xl">
            Real exploits. Nowhere to go.
          </h2>
          <p className="mt-4 max-w-md text-base leading-relaxed text-muted">
            Not a policy you trust. Containment enforced by the substrate, every
            run.
          </p>

          <dl className="mt-10 space-y-5">
            {GUARANTEES.map(([term, def]) => (
              <div key={term} className="flex flex-col gap-1 sm:flex-row sm:gap-4">
                <dt className="w-32 shrink-0 font-mono text-xs uppercase tracking-widest text-accent-bright">
                  {term}
                </dt>
                <dd className="text-sm leading-relaxed text-muted">{def}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* terminal transcript */}
        <div
          className="overflow-hidden rounded-xl border border-white/10 bg-surface"
          style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
        >
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="ml-2 font-mono text-xs text-faint">engagement</span>
          </div>
          <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-relaxed">
            {LINES.map((l, i) => (
              <div
                key={i}
                className={
                  l.accent
                    ? "text-accent-bright"
                    : l.dim
                      ? "text-faint"
                      : "text-muted"
                }
              >
                {l.prompt ? <span className="text-accent-bright">$ </span> : null}
                {l.text}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </Section>
  );
}
