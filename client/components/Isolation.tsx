// The trust section. Containment is the substrate, not a setting. Leads with
// the single best point: authorization is automatic. Plain-words guarantee list.

import Section from "@/components/Section";

const GUARANTEES = [
  [
    "authorized by design",
    "The engine can only ever hit a target the platform built from a repo you control. There's no field to type an arbitrary URL into, because there's no way to attack one.",
  ],
  [
    "truly isolated",
    "Each engagement gets its own Kubernetes namespace on a gVisor sandbox — a real kernel boundary, not just a container.",
  ],
  [
    "locked egress",
    "Default-deny networking. Exactly two paths leave the sandbox: your target and the model API. An escape has nowhere to pivot.",
  ],
  [
    "fail-closed limits",
    "Every action passes a deterministic check against a fixed scope and a spend cap before it runs. No AI gets a vote on what's in bounds.",
  ],
];

export default function Isolation() {
  return (
    <Section id="isolation" eyebrow="containment">
      <h2 className="mt-6 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-text sm:text-5xl">
        The hard part was making it safe. That&apos;s the part we built first.
      </h2>
      <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
        You&apos;re letting an AI run real exploits against real code. That only
        works if it can&apos;t escape, can&apos;t be pointed anywhere it
        shouldn&apos;t, and can&apos;t run up an unbounded bill.
      </p>

      <dl className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2">
        {GUARANTEES.map(([term, def]) => (
          <div key={term}>
            <dt className="font-mono text-xs uppercase tracking-widest text-accent-bright">
              {term}
            </dt>
            <dd className="mt-3 text-sm leading-relaxed text-muted">{def}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
