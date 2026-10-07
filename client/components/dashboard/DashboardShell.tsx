"use client";

// App shell for every dashboard view: a left sidebar, sticky top bar, and a
// centered content column. This replaces the marketing floating navbar inside
// the dashboard so the two surfaces read as different products.
//
// Desktop (lg and up): the sidebar is a fixed left rail and content is inset by
// its width. Below lg the rail would push content off-screen, so there it
// collapses into a slide-in drawer opened from a top-bar menu button and closed
// by a backdrop tap, a nav click, or Escape.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

export default function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const router = useRouter();
  const { status } = useAuth();

  // Route gate: Clerk's server middleware used to do this, but the session now
  // lives in a browser token (lib/token), so the guard is client-side. Bounce
  // signed-out users to /login. The mock/demo build reports a synthetic user, so
  // this never fires there.
  useEffect(() => {
    if (status === "signed-out") router.replace("/login");
  }, [status, router]);

  // Drawer closes on every nav click via Sidebar's onNavigate, plus the backdrop
  // and Escape below. No pathname effect needed.

  // Escape closes the drawer.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className="min-h-screen bg-canvas">
      {/* Backdrop: mobile only, only while the drawer is open. */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />

      <div className="flex min-h-screen flex-col lg:pl-60">
        <Topbar onMenu={() => setNavOpen(true)} />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
