"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, FileText, Headphones, Settings, Radio, Menu, X, Brain } from "lucide-react";

const links = [
  { href: "/",              icon: LayoutDashboard, label: "Topic Discovery",  desc: "Add & curate topics" },
  { href: "/analytics",     icon: Brain,           label: "Analytics",        desc: "Per-topic briefs" },
  { href: "/script-studio", icon: FileText,        label: "Script Studio",    desc: "Edit & generate audio" },
  { href: "/episodes",      icon: Headphones,      label: "Episodes",         desc: "Browse all episodes" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

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
      <p className="px-3 mb-3 text-[10px] font-semibold text-slate-600 uppercase tracking-[0.12em]">Navigation</p>
      {links.map(({ href, icon: Icon, label, desc }) => {
        const isActive = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group relative ${
              isActive
                ? "bg-indigo-500/10 text-white"
                : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200 active:bg-white/[0.07]"
            }`}
          >
            {isActive && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-indigo-400 rounded-full" />
            )}
            <div className={`w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
              isActive ? "bg-indigo-500/20" : "bg-white/[0.04] group-hover:bg-white/[0.07]"
            }`}>
              <Icon className={`w-4 h-4 ${isActive ? "text-indigo-400" : "text-slate-500 group-hover:text-slate-300"}`} />
            </div>
            <div className="min-w-0">
              <div className={`text-sm font-medium leading-tight ${isActive ? "text-white" : ""}`}>{label}</div>
              <div className="text-[11px] text-slate-600 leading-tight mt-0.5 truncate">{desc}</div>
            </div>
          </Link>
        );
      })}
    </>
  );

  const FooterBlock = (
    <>
      <Link
        href="/settings"
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group ${
          pathname === "/settings"
            ? "bg-indigo-500/10 text-white"
            : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300"
        }`}
      >
        <div className="w-9 h-9 sm:w-8 sm:h-8 rounded-lg bg-white/[0.04] group-hover:bg-white/[0.07] flex items-center justify-center shrink-0 transition-colors">
          <Settings className="w-4 h-4" />
        </div>
        <span className="text-sm font-medium">Settings</span>
      </Link>
      <div className="px-3 py-2 flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[11px] text-slate-600">System online</span>
      </div>
    </>
  );

  const LogoBlock = (
    <Link href="/" className="flex items-center gap-2.5 group" onClick={() => setMobileOpen(false)}>
      <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center group-hover:bg-indigo-500/30 transition-colors">
        <Radio className="w-4 h-4 text-indigo-400" />
      </div>
      <div>
        <span className="font-bold text-base text-white tracking-wide leading-none block">TechX TV</span>
        <span className="text-[10px] text-indigo-400/70 font-medium tracking-wider uppercase leading-none">Podcast Studio</span>
      </div>
    </Link>
  );

  return (
    <>
      {/* Mobile top bar */}
      <header className="md:hidden fixed top-0 inset-x-0 h-14 bg-[#0c0c18]/95 backdrop-blur-md border-b border-white/[0.06] z-40 flex items-center justify-between px-4">
        {LogoBlock}
        <button
          type="button"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(v => !v)}
          className="w-10 h-10 -mr-1.5 rounded-xl bg-white/[0.04] active:bg-white/[0.1] hover:bg-white/[0.07] text-slate-300 flex items-center justify-center border border-white/[0.06] transition-colors"
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
        className={`bg-[#0c0c18] border-r border-white/[0.06] flex flex-col shrink-0 z-50
          md:relative md:z-20 md:w-60
          fixed inset-y-0 left-0 w-72 max-w-[85vw] transition-transform duration-300 ease-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0`}
        aria-label="Primary"
      >
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-5 border-b border-white/[0.06]">
          {LogoBlock}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.05] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-5 px-3 space-y-0.5 overflow-y-auto">
          {NavList}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-white/[0.06] space-y-0.5">
          {FooterBlock}
        </div>
      </aside>
    </>
  );
}
