"use client";

import { useEffect, useState } from "react";
import { KeyRound, Cpu, Loader2, CheckCircle2, XCircle, Eye, EyeOff } from "lucide-react";
import {
  getSettingsForUI, saveSetting, testModel,
  type SettingsForUI,
} from "../actions/settings";
import type { Provider, SettingKey } from "../lib/settings";

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "nvidia", label: "NVIDIA NIM" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "claude", label: "Claude" },
];

const API_KEYS: { key: SettingKey; label: string; maskedField: keyof SettingsForUI; hint: string }[] = [
  { key: "nvidia_api_key",    label: "NVIDIA NIM",  maskedField: "nvidia_api_key_masked",    hint: "build.nvidia.com" },
  { key: "openai_api_key",    label: "OpenAI",      maskedField: "openai_api_key_masked",    hint: "platform.openai.com" },
  { key: "gemini_api_key",    label: "Gemini",      maskedField: "gemini_api_key_masked",    hint: "aistudio.google.com/apikey" },
  { key: "claude_api_key",    label: "Claude",      maskedField: "claude_api_key_masked",    hint: "console.anthropic.com" },
  { key: "firecrawl_api_key", label: "Firecrawl",   maskedField: "firecrawl_api_key_masked", hint: "firecrawl.dev — web search, not an AI model" },
];

const STAGES: { stage: "analysis" | "podcast" | "social_scripts" | "youtube_concept" | "quick_posts"; label: string; desc: string }[] = [
  { stage: "analysis",        label: "Research & Scoring",        desc: "Per-topic research brief + weekly social scoring" },
  { stage: "podcast",         label: "Podcast Script",             desc: "Full episode script from the week's briefs" },
  { stage: "social_scripts",  label: "Instagram & YouTube Scripts", desc: "Reel and long-form video scripts, from the brief" },
  { stage: "youtube_concept", label: "YouTube Concept",            desc: "Multi-topic video concept synthesis" },
  { stage: "quick_posts",     label: "Quick Posts (LinkedIn/WhatsApp/X)", desc: "Generated directly from raw scraped sources, skipping the brief, for speed" },
];

function KeyRow({ item, onSaved }: {
  item: typeof API_KEYS[number];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      await saveSetting(item.key, draft);
      setDraft("");
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 py-3 border-b border-black/[0.06] last:border-0">
      <div className="sm:w-40 shrink-0">
        <div className="text-sm font-medium text-neutral-800">{item.label}</div>
        <div className="text-[11px] text-neutral-400">{item.hint}</div>
      </div>
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <div className="flex-1 flex items-center gap-2 bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3 focus-within:border-red-500/40 transition-colors">
          <input
            type={visible ? "text" : "password"}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Enter a new key to replace the saved one…"
            className="flex-1 bg-transparent py-2.5 text-sm text-neutral-900 placeholder-neutral-400 outline-none min-w-0"
          />
          <button type="button" onClick={() => setVisible(v => !v)} className="text-neutral-400 hover:text-neutral-700 shrink-0" tabIndex={-1}>
            {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !draft.trim()}
          className="flex items-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] disabled:opacity-40 text-neutral-800 text-xs px-3 py-2.5 rounded-xl border border-black/[0.08] transition-all shrink-0"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

function StageRow({ item, initialProvider, initialModel, onSaved }: {
  item: typeof STAGES[number];
  initialProvider: Provider;
  initialModel: string;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [model, setModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);

  const dirty = provider !== initialProvider || model !== initialModel;

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await Promise.all([
        saveSetting(`${item.stage}_provider` as SettingKey, provider),
        saveSetting(`${item.stage}_model` as SettingKey, model),
      ]);
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testModel(provider, model);
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="py-3.5 border-b border-black/[0.06] last:border-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <div className="text-sm font-medium text-neutral-800">{item.label}</div>
          <div className="text-[11px] text-neutral-400">{item.desc}</div>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={provider}
          onChange={e => setProvider(e.target.value as Provider)}
          className="bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-red-500/40 transition-colors sm:w-40 shrink-0"
        >
          {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <input
          type="text"
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder="exact model name, e.g. mistralai/mistral-medium-3.5-128b"
          className="flex-1 bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3 py-2.5 text-sm text-neutral-900 placeholder-neutral-400 outline-none focus:border-red-500/40 transition-colors min-w-0"
        />
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleTest}
            disabled={testing || !model.trim()}
            className="flex items-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] disabled:opacity-40 text-neutral-800 text-xs px-3 py-2.5 rounded-xl border border-black/[0.08] transition-all"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Test
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="flex items-center gap-1.5 bg-black/[0.04] hover:bg-black/[0.08] disabled:opacity-40 text-neutral-800 text-xs px-3 py-2.5 rounded-xl border border-black/[0.08] transition-all"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : null}
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>
      {testResult && (
        <div className={`flex items-center gap-1.5 mt-2 text-[11px] ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>
          {testResult.ok ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <XCircle className="w-3 h-3 shrink-0" />}
          <span>{testResult.message}{testResult.latencyMs ? ` (${(testResult.latencyMs / 1000).toFixed(1)}s)` : ""}</span>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsForUI | null>(null);

  const load = async () => setSettings(await getSettingsForUI());

  useEffect(() => { load(); }, []);

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-5 h-5 text-neutral-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-up max-w-3xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-black">Settings</h1>
        <p className="text-sm text-neutral-500 mt-1">
          API keys and which model each part of the pipeline uses. Keys are saved once and shared across
          every stage that picks that provider — models are typed freely and can be switched per stage.
        </p>
      </div>

      <div className="bg-white border border-black/[0.08] rounded-2xl overflow-hidden card-glow">
        <div className="px-4 sm:px-5 py-3.5 border-b border-black/[0.07] bg-black/[0.01]">
          <h2 className="text-sm font-semibold text-neutral-800 flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-red-600" /> API Keys
          </h2>
        </div>
        <div className="px-4 sm:px-5">
          {API_KEYS.map(item => (
            <div key={item.key}>
              <div className="pt-1 pb-0.5 text-[11px] text-neutral-400">
                {settings[item.maskedField] ? `Saved: ${settings[item.maskedField]}` : "Not set — falls back to the server's env var if any"}
              </div>
              <KeyRow item={item} onSaved={load} />
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white border border-black/[0.08] rounded-2xl overflow-hidden card-glow">
        <div className="px-4 sm:px-5 py-3.5 border-b border-black/[0.07] bg-black/[0.01]">
          <h2 className="text-sm font-semibold text-neutral-800 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-red-600" /> Pipeline Models
          </h2>
        </div>
        <div className="px-4 sm:px-5">
          {STAGES.map(item => (
            <StageRow
              key={item.stage}
              item={item}
              initialProvider={settings[`${item.stage}_provider` as keyof SettingsForUI] as Provider}
              initialModel={settings[`${item.stage}_model` as keyof SettingsForUI] as string}
              onSaved={load}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
