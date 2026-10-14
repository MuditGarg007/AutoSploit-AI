// AutoSploit AI landing page. The hero stays dark (MicroSlats burgundy on true
// black); every section after it alternates light/dark. The landing theme is
// fixed and pinned per section via data-theme wrappers, independent of the
// dashboard's light/dark toggle. Each wrapper paints its own bg-canvas.

import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import Problem from "@/components/Problem";
import HowItWorks from "@/components/HowItWorks";
import Features from "@/components/Features";
import LiveDashboard from "@/components/LiveDashboard";
import Isolation from "@/components/Isolation";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";
import { SignInProvider } from "@/components/SignInModal";

export default function Home() {
  return (
    <SignInProvider>
      {/* Navbar floats over the dark hero and reads as a dark glass bar over
          every section, so pin it dark. */}
      <div data-theme="dark">
        <Navbar />
      </div>
      <main className="flex-1">
        <div data-theme="dark" className="bg-canvas">
          <Hero />
        </div>
        <div data-theme="light" className="bg-canvas">
          <Problem />
        </div>
        <div data-theme="dark" className="bg-canvas">
          <HowItWorks />
        </div>
        <div data-theme="light" className="bg-canvas">
          <Features />
        </div>
        <div data-theme="dark" className="bg-canvas">
          <Isolation />
        </div>
        <div data-theme="light" className="bg-canvas">
          <LiveDashboard />
        </div>
        <div data-theme="dark" className="bg-canvas">
          <CTA />
        </div>
      </main>
      <div data-theme="light" className="bg-canvas">
        <Footer />
      </div>
    </SignInProvider>
  );
}
