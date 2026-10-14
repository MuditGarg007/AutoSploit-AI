"use client";

// Quiet icon button that flips light/dark. Same hover affordance as the other
// bar controls (text-muted, hover:bg-white/5 which the theme override maps to a
// subtle wash in both themes). No status dot, no label text: one icon showing
// the theme you'd switch to.

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

export default function ThemeToggle({
  className = "",
}: {
  className?: string;
}) {
  const { theme, toggle } = useTheme();
  const toDark = theme === "light";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={toDark ? "Switch to dark theme" : "Switch to light theme"}
      title={toDark ? "Dark theme" : "Light theme"}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-text active:scale-[0.97] ${className}`}
    >
      {toDark ? <Moon size={17} /> : <Sun size={17} />}
    </button>
  );
}
