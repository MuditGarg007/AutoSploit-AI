// The real flow: GitHub -> repo -> deploy -> attack -> report. Four numbered
// steps, left rule in the accent. This is the section that tells a visitor what
// they'd actually do.

import Section from "@/components/Section";

const STEPS = [
  {
    n: "01",
    title: "Connect GitHub",
    body: "Sign in and grant access. We only ever touch repos you already have access to — which is also how we know the attack is authorized.",
  },
  {
    n: "02",
    title: "Pick a repo",
    body: "Choose the app you want tested. If it ships a docker-compose.yml or a Dockerfile, it's ready to go.",
  },
  {
    n: "03",
    title: "We deploy it, then attack it",
    body: "The platform stands your app up as a real running instance in an isolated sandbox, then points an autonomous attack engine at the live target — the way an attacker would, not by reading your code.",
  },
  {
    n: "04",
    title: "Watch it live, read the report",
    body: "Every move streams to your dashboard as it happens. When it's done you get a report of what it actually exploited, and the sandbox is destroyed.",
  },
];

export default function HowItWorks() {
  return (
    <Section id="flow" eyebrow="how it works">
      <h2 className="mt-6 max-w-2xl text-3xl font-semibold tracking-tight text-text sm:text-5xl">
        From a GitHub repo to a live attack in minutes.
      </h2>
      <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
        No agents to install, no targets to configure, no scope to hand-write.
        You give it a repo; it does the rest.
      </p>

      <ol className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
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
