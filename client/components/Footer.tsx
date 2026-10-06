// Quiet footer. Image wordmark logo, hairline top border.

import Image from "next/image";

const COLS = [
  {
    heading: "Platform",
    links: ["Overview", "Isolation", "How it works", "Changelog"],
  },
  {
    heading: "Developers",
    links: ["Docs", "CLI reference", "Scope contract", "Status"],
  },
  {
    heading: "Company",
    links: ["About", "Security", "Contact"],
  },
];

export default function Footer() {
  return (
    <footer className="border-t border-white/10 px-6 py-16">
      <div className="mx-auto grid w-full max-w-5xl gap-12 sm:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Image
            src="/logo.png"
            alt="AutoSploit AI"
            width={1323}
            height={213}
            className="h-6 w-auto"
          />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
            Autonomous red-team engagements that run isolated and clean up after
            themselves.
          </p>
        </div>

        {COLS.map((col) => (
          <div key={col.heading}>
            <span className="font-mono text-xs uppercase tracking-widest text-faint">
              {col.heading}
            </span>
            <ul className="mt-4 space-y-3">
              {col.links.map((l) => (
                <li key={l}>
                  <a
                    href="#"
                    className="text-sm text-muted transition-colors hover:text-text"
                  >
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mx-auto mt-14 flex w-full max-w-5xl items-center justify-between border-t border-white/10 pt-6">
        <span className="font-mono text-xs text-faint">
          © {new Date().getFullYear()} AutoSploit AI
        </span>
        <span className="font-mono text-xs text-faint">
          self-hosted red-team
        </span>
      </div>
    </footer>
  );
}
