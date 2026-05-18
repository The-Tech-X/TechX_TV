"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FileText, Headphones, Settings, Radio } from "lucide-react";

const links = [
  { href: "/",              icon: LayoutDashboard, label: "Topic Discovery",  desc: "Add & curate topics" },
  { href: "/script-studio", icon: FileText,        label: "Script Studio",    desc: "Edit & generate audio" },
  { href: "/episodes",      icon: Headphones,      label: "Episodes",         desc: "Browse all episodes" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 bg-[#0c0c18] border-r border-white/[0.06] flex-col hidden md:flex shrink-0 relative z-20">
      {/* Logo */}
      <div className="h-16 flex items-center px-5 border-b border-white/[0.06]">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center group-hover:bg-indigo-500/30 transition-colors">
            <Radio className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <span className="font-bold text-base text-white tracking-wide leading-none block">TechX TV</span>
            <span className="text-[10px] text-indigo-400/70 font-medium tracking-wider uppercase leading-none">Podcast Studio</span>
          </div>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-5 px-3 space-y-0.5">
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
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-indigo-400 rounded-full" />
              )}
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
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
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-white/[0.06] space-y-0.5">
        <Link
          href="/settings"
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group ${
            pathname === "/settings"
              ? "bg-indigo-500/10 text-white"
              : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300"
          }`}
        >
          <div className="w-8 h-8 rounded-lg bg-white/[0.04] group-hover:bg-white/[0.07] flex items-center justify-center shrink-0 transition-colors">
            <Settings className="w-4 h-4" />
          </div>
          <span className="text-sm font-medium">Settings</span>
        </Link>
        <div className="px-3 py-2 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[11px] text-slate-600">System online</span>
        </div>
      </div>
    </aside>
  );
}
