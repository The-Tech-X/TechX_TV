import { ListChecks } from "lucide-react";

export function Field({
  icon, label, hint, value, onChange, rows = 3,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-3 mb-1.5">
        <label className="text-xs font-semibold text-neutral-800 flex items-center gap-1.5 shrink-0">
          <span className="text-red-600">{icon}</span>
          {label}
        </label>
        <span className="text-[11px] text-neutral-400 sm:text-right">{hint}</span>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className="w-full bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 leading-relaxed focus:outline-none focus:border-red-500/40 transition-colors resize-y"
      />
    </div>
  );
}

export function KeyFactsField({
  facts, onChange,
}: { facts: string[]; onChange: (next: string[]) => void }) {
  // Internal textarea representation — one fact per line, easy to edit.
  const text = facts.join("\n");
  const handle = (v: string) => {
    const next = v.split("\n").map(s => s.replace(/^[-•*\s]+/, "").trim()).filter(Boolean);
    onChange(next);
  };
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-3 mb-1.5">
        <label className="text-xs font-semibold text-neutral-800 flex items-center gap-1.5 shrink-0">
          <span className="text-red-600"><ListChecks className="w-3.5 h-3.5" /></span>
          Key facts
        </label>
        <span className="text-[11px] text-neutral-400 sm:text-right">One fact per line — concrete, numerical when possible.</span>
      </div>
      <textarea
        value={text}
        onChange={e => handle(e.target.value)}
        rows={Math.max(4, facts.length + 1)}
        spellCheck={false}
        placeholder="• 4 parallel agents&#10;• 256K context window&#10;• Free during preview"
        className="w-full bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-neutral-900 leading-relaxed focus:outline-none focus:border-red-500/40 transition-colors resize-y font-[ui-monospace,Menlo,monospace]"
      />
    </div>
  );
}
