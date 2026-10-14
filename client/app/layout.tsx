import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { ThemeProvider, themeInitScript } from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Base URL for absolute metadata URLs (OpenGraph, Twitter, canonical). Set
// NEXT_PUBLIC_SITE_URL to the production origin at deploy time (Phase 3). The
// localhost fallback keeps local builds from erroring on relative image paths.
// A bare domain (no scheme) is tolerated: new URL() needs a protocol, so https
// is assumed when one is missing.
const rawSiteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const siteUrl = /^https?:\/\//.test(rawSiteUrl)
  ? rawSiteUrl
  : `https://${rawSiteUrl}`;

const title = "AutoSploit AI: autonomous red-team";
const description =
  "Isolated, disposable red-team engagements. Real exploits, contained in gVisor-sandboxed pods, torn down on exit.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "AutoSploit AI",
  // app/icon.png (a circular favicon) is picked up automatically; the og/twitter
  // images come from app/opengraph-image.tsx via the file-based metadata API.
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
  // Light is the default theme; the OS bar tint follows it unless the user
  // opts into dark (handled client-side via data-theme).
  themeColor: "#ffffff",
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the themeInitScript sets data-theme on <html>
    // before React hydrates, so the attribute legitimately differs from the
    // server-rendered markup on dark-theme visitors.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-canvas text-muted">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
