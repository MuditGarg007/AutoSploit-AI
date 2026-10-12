// Minimal, dependency-free markdown renderer for model-generated summaries.
// The conductor emits phase summaries as markdown (often as a single blob with
// `##`/`###`/`####` headings, `**bold**`, `` `code` `` and numbered/bulleted
// lists inline). Rendering that verbatim shows the raw `#` and `*` symbols: a
// wall of syntax. This turns the common constructs into real elements. It is
// deliberately small: it covers what the summaries actually use, not the full
// CommonMark spec, and never injects HTML (nodes are built in React).

import { Fragment, type ReactNode } from "react";

// Inline: **bold** and `code`. Split on the two token kinds, keeping captures.
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-text">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em] text-text"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "li"; text: string }
  | { kind: "p"; text: string };

// Summaries often arrive as one line with headings/list markers inline. Break
// before each heading marker and before numbered items so blocks can form, then
// classify line by line.
function toBlocks(raw: string): Block[] {
  const normalized = raw
    .replace(/\s+(#{1,6}\s)/g, "\n$1") // headings onto their own line
    .replace(/\s+(\d+\.\s)/g, "\n$1"); // numbered items onto their own line

  const blocks: Block[] = [];
  for (const line of normalized.split(/\n+/)) {
    const s = line.trim();
    if (!s) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(s);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    if (/^(?:[-*]|\d+\.)\s+/.test(s)) {
      blocks.push({ kind: "li", text: s.replace(/^(?:[-*]|\d+\.)\s+/, "") });
      continue;
    }
    blocks.push({ kind: "p", text: s });
  }
  return blocks;
}

function Heading({ level, text }: { level: number; text: string }) {
  // Collapse the summary's heading range into two visual weights so the block
  // keeps a hierarchy without shouting.
  const strong = level <= 3;
  return (
    <p
      className={
        strong
          ? "mt-4 text-sm font-semibold text-text first:mt-0"
          : "mt-3 text-[11px] font-semibold uppercase tracking-wider text-faint first:mt-0"
      }
    >
      {renderInline(text)}
    </p>
  );
}

export default function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const blocks = toBlocks(children);

  // Group runs of list items into a single <ul>.
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (key: string) => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={key} className="my-2 flex list-disc flex-col gap-1 pl-5">
        {bullets.map((b, i) => (
          <li key={i}>{renderInline(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  blocks.forEach((b, i) => {
    if (b.kind === "li") {
      bullets.push(b.text);
      return;
    }
    flush(`ul-${i}`);
    if (b.kind === "heading") {
      out.push(<Heading key={i} level={b.level} text={b.text} />);
    } else {
      out.push(
        <p key={i} className="mt-2 first:mt-0">
          {renderInline(b.text)}
        </p>,
      );
    }
  });
  flush("ul-end");

  return <div className={className}>{out}</div>;
}
