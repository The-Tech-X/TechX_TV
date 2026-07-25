"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, FileText, Headphones, Menu, X, Brain, Clapperboard, Compass, Settings, LogOut } from "lucide-react";

const links = [
  { href: "/",             icon: LayoutDashboard, label: "Dashboard",   desc: "Production status" },
  { href: "/discover",     icon: Compass,         label: "Discover",    desc: "Add & curate topics" },
  { href: "/analytics",    icon: Brain,           label: "Analytics",   desc: "Per-topic briefs" },
  { href: "/productions",  icon: Clapperboard,    label: "Productions", desc: "Reels & Videos, scored" },
  { href: "/podcast",      icon: FileText,        label: "Podcast",     desc: "Edit & generate audio" },
  { href: "/episodes",     icon: Headphones,      label: "Episodes",    desc: "Browse all episodes" },
  { href: "/settings",     icon: Settings,        label: "Settings",    desc: "API keys & models" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  };

  // Close mobile drawer on route change
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Lock body scroll when drawer open
  useEffect(() => {
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [mobileOpen]);

  // Close on Escape
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const NavList = (
    <>
      <p className="px-3 mb-3 text-[10px] font-semibold text-neutral-400 uppercase tracking-[0.12em]">Navigation</p>
      {links.map(({ href, icon: Icon, label, desc }) => {
        const isActive = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group relative ${
              isActive
                ? "bg-red-500/10 text-black"
                : "text-neutral-600 hover:bg-black/[0.04] hover:text-neutral-900 active:bg-black/[0.07]"
            }`}
          >
            {isActive && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-red-600 rounded-full" />
            )}
            <div className={`w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
              isActive ? "bg-red-500/20" : "bg-black/[0.04] group-hover:bg-black/[0.07]"
            }`}>
              <Icon className={`w-4 h-4 ${isActive ? "text-red-600" : "text-neutral-500 group-hover:text-neutral-800"}`} />
            </div>
            <div className="min-w-0">
              <div className={`text-sm font-medium leading-tight ${isActive ? "text-black" : ""}`}>{label}</div>
              <div className="text-[11px] text-neutral-400 leading-tight mt-0.5 truncate">{desc}</div>
            </div>
          </Link>
        );
      })}
    </>
  );

  const FooterBlock = (
    <div className="px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[11px] text-neutral-400">System online</span>
      </div>
      <button
        type="button"
        onClick={handleLogout}
        disabled={loggingOut}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-neutral-500 hover:text-red-600 hover:bg-red-500/[0.06] disabled:opacity-50 transition-colors text-[11px] font-medium"
      >
        <LogOut className="w-3.5 h-3.5" />
        {loggingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );

  const LogoBlock = (
    <Link href="/" className="flex items-center group" onClick={() => setMobileOpen(false)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="https://res.cloudinary.com/daq0xtstq/image/upload/v1782920267/THE_TECH_3_o0wnmr.svg"
        alt="The TechX Studio"
        className="h-8 w-auto"
      />
    </Link>
  );

  if (pathname === "/login") return null;

  return (
    <>
      {/* Mobile top bar */}
      <header className="md:hidden fixed top-0 inset-x-0 h-14 bg-white/95 backdrop-blur-md border-b border-black/[0.08] z-40 flex items-center justify-between px-4">
        {LogoBlock}
        <button
          type="button"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(v => !v)}
          className="w-10 h-10 -mr-1.5 rounded-xl bg-black/[0.04] active:bg-black/[0.1] hover:bg-black/[0.07] text-neutral-800 flex items-center justify-center border border-black/[0.08] transition-colors"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </header>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-fade-in"
        />
      )}

      {/* Sidebar — desktop static, mobile slide-in */}
      <aside
        className={`bg-white border-r border-black/[0.08] flex flex-col shrink-0 z-50
          md:relative md:z-20 md:w-60
          fixed inset-y-0 left-0 w-72 max-w-[85vw] transition-transform duration-300 ease-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0`}
        aria-label="Primary"
      >
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-5 border-b border-black/[0.08]">
          {LogoBlock}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1.5 rounded-lg text-neutral-600 hover:text-black hover:bg-black/[0.05] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-5 px-3 space-y-0.5 overflow-y-auto">
          {NavList}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-black/[0.08] space-y-0.5">
          {FooterBlock}
        </div>
      </aside>
    </>
  );
}
