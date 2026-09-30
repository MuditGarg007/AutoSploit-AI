// Three-step flow. Numbered, left rule in the accent, plain words for state.

import Section from "@/components/Section";

const STEPS = [
  {
    n: "01",
    title: "Define the scope",
    body: "Point at a target and a boundary. The versioned scope contract rides every run.",
  },
  {
    n: "02",
    title: "Run it isolated",
    body: "The conductor schedules onto self-hosted Kubernetes. gVisor and NetworkPolicy do the rest.",
  },
  {
    n: "03",
    title: "Read the report",
    body: "Reproducible findings out. The cluster returns to zero, verified.",
  },
];

export default function HowItWorks() {
  return (
    <Section id="flow" eyebrow="how it works">
      <h2 className="mt-6 max-w-2xl text-3xl font-semibold tracking-tight text-text sm:text-5xl">
        Scope in, findings out.
      </h2>

      <ol className="mt-14 grid gap-10 sm:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="border-l border-white/10 pl-5">
            <span className="font-mono text-sm font-semibold text-accent-bright">
              {s.n}
            </span>
            <h3 className="mt-4 text-lg font-semibold tracking-tight text-text">
              {s.title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
