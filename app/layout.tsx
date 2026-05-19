import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "./components/Sidebar";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "TechX TV — Podcast Studio",
  description: "AI-powered tech podcast generator. Research, script, and publish episodes with real insights.",
};

export const viewport: Viewport = {
  themeColor: "#080810",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-[var(--font-inter)] bg-[#080810] text-slate-200 min-h-[100svh] flex antialiased overflow-x-hidden`}>
        {/* Ambient background */}
        <div className="fixed inset-0 pointer-events-none z-0" aria-hidden>
          <div className="absolute top-0 md:left-60 right-0 h-px bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent" />
          <div className="absolute top-[-200px] left-[30%] w-[600px] h-[600px] rounded-full bg-indigo-600/[0.04] blur-[120px]" />
          <div className="absolute bottom-[-100px] right-[10%] w-[400px] h-[400px] rounded-full bg-violet-600/[0.03] blur-[100px]" />
        </div>

        <Sidebar />

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative z-10 pt-14 md:pt-0">
          <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6 md:p-8 pb-[env(safe-area-inset-bottom)]">
            <div className="max-w-6xl mx-auto w-full">
              {children}
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
