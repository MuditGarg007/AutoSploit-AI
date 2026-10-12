// "Real findings, not a scan." Why DAST beats SAST, said plainly, backed by a
// strip of actual exploits from live Juice Shop runs.

import Section from "@/components/Section";

const FOUND = [
  ["SQL injection", "Dumped data straight out of a login form."],
  ["Auth bypass", "Forged an admin session with a tampered JWT."],
  ["Business logic", "Slipped a manipulated order past checkout."],
];

export default function Features() {
  return (
    <Section id="platform" eyebrow="what you get">
      <h2 className="mt-6 max-w-2xl text-3xl font-semibold tracking-tight text-text sm:text-5xl">
        It breaks in. Then it shows you how.
      </h2>
      <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
        Because it attacks a running copy of your app instead of grepping
        source, every finding is something it actually pulled off — with the
        steps to reproduce it. No theoretical CVE noise, no &quot;this might be
        exploitable if.&quot; If it&apos;s in your report, it happened.
      </p>

      <div className="mt-14 grid gap-px overflow-hidden rounded-md border border-white/10 bg-white/10 sm:grid-cols-3">
        {FOUND.map(([tag, body]) => (
          <div key={tag} className="bg-surface p-8">
            <span className="font-mono text-xs uppercase tracking-widest text-accent-bright">
              {tag}
            </span>
            <p className="mt-4 text-sm leading-relaxed text-muted">{body}</p>
          </div>
        ))}
      </div>

      <p className="mt-6 font-mono text-xs text-faint">
        From live runs against OWASP Juice Shop.
      </p>
    </Section>
  );
}
