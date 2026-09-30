import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AutoSploit AI — autonomous red-team",
  description:
    "Isolated, disposable red-team engagements. Real exploits, contained in gVisor-sandboxed pods, torn down on exit.",
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
