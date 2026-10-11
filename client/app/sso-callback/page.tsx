// OAuth landing fallback. The control plane redirects straight to /dashboard
// (the refresh cookie is already set; useAuth mints the first access token via
// /auth/refresh on load). If the callback is ever pointed here instead, just
// forward to the dashboard and let the same path run.
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SSOCallback() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <span className="font-mono text-xs uppercase tracking-widest text-faint">
        Completing sign in
      </span>
    </main>
  );
}
