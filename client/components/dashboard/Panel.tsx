// Content card for dashboard sections. Surface fill, hairline border, a plain
// white title on the left and an optional right slot (a count, a control). This
// follows the Neon card vibe: sentence-case title in Geist Sans, quiet body,
// 6px radius, no shadow (design rules). Use `flush` when the body is a table or
// list that manages its own padding.

import { cn } from "@/lib/format";
import type { IconProps } from "./icons";

export default function Panel({
  title,
  icon: Icon,
  aside,
  className,
  bodyClassName,
  flush,
  floating,
  children,
}: {
  title?: string;
  icon?: (p: IconProps) => React.ReactElement;
  aside?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
  // Floating variant: used when the panel sits *over* the activity console in
  // the engagement cockpit, so it needs a translucent blurred fill and a
  // restrained elevation to read against the scrolling text behind it, rather
  // than the flat solid surface a panel gets when it sits in document flow.
  floating?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-md border border-white/10",
        floating
          ? "bg-surface/80 shadow-lg shadow-black/40 backdrop-blur-md"
          : "bg-surface",
        className,
      )}
    >
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-text">
            {Icon && <Icon size={15} className="text-faint" />}
            {title}
          </h2>
          {aside}
        </header>
      )}
      <div className={cn(!flush && "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}
