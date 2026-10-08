"use client";

// Sign-in overlay for the landing page. Instead of routing to /login, the
// navbar and the two "Get started" calls open this menu in place: the page
// behind it is dimmed to near-black and the SignInCard floats on a hairline
// surface. SignInProvider wraps the landing tree and owns the open state;
// useSignIn opens it from anywhere inside; SignInTrigger is the button shim for
// server components (the Hero and CTA) that only need to open it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import SignInCard from "@/components/SignInCard";

const SignInContext = createContext<(() => void) | null>(null);

/** Open the sign-in overlay. Only valid under <SignInProvider>. */
export function useSignIn(): () => void {
  const open = useContext(SignInContext);
  if (!open) throw new Error("useSignIn must be used within <SignInProvider>");
  return open;
}

export function SignInProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // While the overlay is up: Escape closes it, and the page behind it does not
  // scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  return (
    <SignInContext.Provider value={() => setOpen(true)}>
      {children}
      {/* `open` only turns true on a client click, so document.body exists. */}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="signin-title"
            >
              {/* the page behind, dimmed to near-black */}
              <button
                type="button"
                aria-label="Close sign in"
                onClick={close}
                className="absolute inset-0 cursor-default bg-black/80"
              />

              <div className="relative w-full max-w-sm rounded-md border border-white/10 bg-surface p-8">
                <button
                  type="button"
                  aria-label="Close sign in"
                  onClick={close}
                  className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-text active:scale-[0.97]"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                <SignInCard titleId="signin-title" />
              </div>
            </div>,
            document.body,
          )
        : null}
    </SignInContext.Provider>
  );
}

/**
 * A plain button that opens the overlay, for server components that only need
 * the trigger (and so cannot call useSignIn themselves).
 */
export function SignInTrigger({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const open = useSignIn();
  return (
    <button type="button" onClick={open} className={className}>
      {children}
    </button>
  );
}
