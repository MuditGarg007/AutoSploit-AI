"use client";

// App shell for dashboard views. The old left sidebar is gone; navigation now
// lives in a full-width top bar (the index) or in the engagement cockpit's own
// bar. The shell is left with two real jobs: the client-side auth gate and the
// new-engagement modal provider.
//
// Two layouts:
//   default    a sticky top nav + a centered content column (the index page).
//   fullBleed  no chrome at all, the child owns the whole viewport (the live
//              engagement cockpit, which carries its own bar + nav buttons).

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import DashboardNav from "./DashboardNav";
import { NewEngagementProvider } from "./NewEngagementPanel";

export default function DashboardShell({
  children,
  fullBleed,
}: {
  children: React.ReactNode;
  fullBleed?: boolean;
}) {
  const router = useRouter();
  const { status } = useAuth();

  // Route gate: the session lives in a browser token (lib/token), not a
  // server-readable cookie, so the guard is client-side. Bounce signed-out
  // users to /login. The mock/demo build reports a synthetic user, so this
  // never fires there.
  useEffect(() => {
    if (status === "signed-out") router.replace("/login");
  }, [status, router]);

  return (
    <NewEngagementProvider>
      {fullBleed ? (
        <div className="min-h-screen bg-canvas">{children}</div>
      ) : (
        <div className="flex min-h-screen flex-col bg-canvas">
          <DashboardNav />
          <main className="flex-1">
            <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8">
              {children}
            </div>
          </main>
        </div>
      )}
    </NewEngagementProvider>
  );
}
