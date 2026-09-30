// The engagement lifecycle as four cards. Surface cards, hairline borders,
// one short line each. No icons, no dots.

import Section from "@/components/Section";

const STEPS = [
  {
    tag: "01",
    title: "Provision",
    body: "An isolated engagement spun up on demand, fail-closed.",
  },
  {
    tag: "02",
    title: "Isolate",
    body: "Every workload in a gVisor sandbox behind default-deny.",
  },
  {
    tag: "03",
    title: "Exploit",
    body: "Real, digest-pinned exploit chains against scoped targets.",
  },
  {
    tag: "04",
    title: "Teardown",
    body: "On exit the engagement erases itself. Verified to zero.",
  },
];

export default function Features() {
  return (
    <Section id="platform" eyebrow="the platform">
      <h2 className="mt-6 max-w-2xl text-3xl font-semibold tracking-tight text-text sm:text-5xl">
        One command. Full engagement. No trace.
      </h2>

      <div className="mt-14 grid gap-px overflow-hidden rounded-md border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <div
            key={s.title}
            className="group bg-surface p-8 transition-colors hover:bg-surface-2"
          >
            <span className="font-mono text-xs uppercase tracking-widest text-faint">
              {s.tag}
            </span>
            <h3 className="mt-5 text-lg font-semibold tracking-tight text-text">
              {s.title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-muted">{s.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
