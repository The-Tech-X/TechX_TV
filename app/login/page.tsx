"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Lock } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Login failed");
        setLoading(false);
        return;
      }
      const from = searchParams.get("from") || "/";
      router.push(from);
      router.refresh();
    } catch {
      setError("Could not reach the server");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white border border-black/[0.08] rounded-2xl p-6 sm:p-7 card-glow space-y-4"
      >
        <div className="flex flex-col items-center text-center gap-2 mb-2">
          <div className="w-11 h-11 rounded-xl bg-red-500/10 flex items-center justify-center">
            <Lock className="w-5 h-5 text-red-600" />
          </div>
          <h1 className="text-lg font-bold text-black">The TechX Studio</h1>
          <p className="text-sm text-neutral-500">Sign in to continue</p>
        </div>

        <div>
          <label className="text-[11px] font-medium text-neutral-500 mb-1 block">Email</label>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-red-500/40 transition-colors"
          />
        </div>

        <div>
          <label className="text-[11px] font-medium text-neutral-500 mb-1 block">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full bg-[#f5f5f5] border border-black/[0.08] rounded-xl px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-red-500/40 transition-colors"
          />
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-all shadow-lg shadow-red-500/20"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
