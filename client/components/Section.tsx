// Shared section shell. Hairline top border separates sections (design rule),
// a small mono eyebrow label, then children. Keeps spacing consistent.

import type { ReactNode } from "react";

type SectionProps = {
  id?: string;
  eyebrow?: string;
  className?: string;
  children: ReactNode;
};

export default function Section({
  id,
  eyebrow,
  className,
  children,
}: SectionProps) {
  return (
    <section
      id={id}
      className={`border-t border-white/10 px-6 py-24 sm:py-32 ${className ?? ""}`}
    >
      <div className="mx-auto w-full max-w-5xl">
        {eyebrow ? (
          <span className="font-mono text-xs uppercase tracking-widest text-faint">
            {eyebrow}
          </span>
        ) : null}
        {children}
      </div>
    </section>
  );
}
