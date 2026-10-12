// Opening frame: why this exists. Eyebrow + headline + one honest paragraph.
// No cards — it just sets up the contrast the rest of the page pays off.

import Section from "@/components/Section";

export default function Problem() {
  return (
    <Section id="why" eyebrow="why this exists">
      <h2 className="mt-6 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-text sm:text-5xl">
        You ship every day. Your security testing doesn&apos;t.
      </h2>
      <p className="mt-7 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
        A real pentest happens maybe once a quarter, costs a fortune, and is
        stale the moment someone merges. Static scanners run on every push, but
        they read your source and hand you a pile of maybes — most of which were
        never reachable to begin with. Neither one answers the question you
        actually care about: right now, can someone break into my app?
      </p>
    </Section>
  );
}
