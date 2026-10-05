"use client";

// Root error boundary. Catches render/runtime errors in the route tree and
// offers a retry. Kept on-palette: true black, hairline border, one action.
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-md text-center">
        <span className="font-mono text-xs uppercase tracking-widest text-faint">
          Error
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-text">
          Something broke
        </h1>
        <p className="mt-2 text-sm text-muted">
          An unexpected error stopped this page. Try again.
        </p>
        {error.digest ? (
          <p className="mt-4 font-mono text-xs text-faint">
            ref: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="mt-8 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-bright active:scale-[0.99]"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
