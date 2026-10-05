import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-md text-center">
        <span className="font-mono text-xs uppercase tracking-widest text-faint">
          404
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-text">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted">
          This route does not exist, or it moved.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex h-9 items-center rounded-md border border-border px-4 text-sm text-muted transition-colors hover:border-border-strong hover:text-text active:scale-[0.99]"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
