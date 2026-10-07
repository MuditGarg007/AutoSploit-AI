// OAuth landing fallback. The control plane normally redirects straight to
// /dashboard?access_token=..., but if it is ever pointed here instead, capture
// the token the same way and forward to the dashboard.
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { captureTokenFromUrl } from "@/lib/token";

export default function SSOCallback() {
  const router = useRouter();

  useEffect(() => {
    captureTokenFromUrl();
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
