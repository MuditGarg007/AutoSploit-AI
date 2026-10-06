import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Base URL for absolute metadata URLs (OpenGraph, Twitter, canonical). Set
// NEXT_PUBLIC_SITE_URL to the production origin at deploy time (Phase 3). The
// localhost fallback keeps local builds from erroring on relative image paths.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

const title = "AutoSploit AI: autonomous red-team";
const description =
  "Isolated, disposable red-team engagements. Real exploits, contained in gVisor-sandboxed pods, torn down on exit.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "AutoSploit AI",
  // app/favicon.ico is picked up automatically; the og/twitter images come from
  // app/opengraph-image.tsx via the file-based metadata API.
  openGraph: {
    type: "website",
    siteName: "AutoSploit AI",
    url: siteUrl,
    title,
    description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col bg-canvas text-muted">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
