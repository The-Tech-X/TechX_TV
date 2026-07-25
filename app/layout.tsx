import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "./components/Sidebar";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "The TechX Studio",
  description: "The TechX's content studio — research a story once, produce a podcast episode, Reel, YouTube video, LinkedIn post, WhatsApp update, and X post from the same brief.",
  icons: {
    icon: "https://res.cloudinary.com/daq0xtstq/image/upload/v1774724198/THE_TECH_1_v22x8k.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-[var(--font-inter)] bg-white text-neutral-800 min-h-[100svh] flex antialiased overflow-x-hidden`}>
        {/* Ambient background */}
        <div className="fixed inset-0 pointer-events-none z-0" aria-hidden>
          <div className="absolute top-0 md:left-60 right-0 h-px bg-gradient-to-r from-transparent via-red-500/25 to-transparent" />
          <div className="absolute top-[-200px] left-[30%] w-[600px] h-[600px] rounded-full bg-red-600/[0.05] blur-[120px]" />
          <div className="absolute bottom-[-100px] right-[10%] w-[400px] h-[400px] rounded-full bg-red-400/[0.04] blur-[100px]" />
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
