# TechX TV — AI Podcast Studio

A Next.js 16 app for producing a sharp, no-nonsense tech podcast end-to-end:

1. **Capture** news URLs → auto-scraped into a topics list.
2. **Curate** which stories make this episode.
3. **Analyze** each story with Firecrawl web search + Mistral Large 3 reasoning → an editable structured brief (Summary / Why now / Key facts / Bigger picture / Honest take).
4. **Generate** one flowing podcast script (English or Tenglish) that applies real audio-retention craft — cold-open hook, dopamine curiosity gaps, three storytelling frameworks (What/So What/Now What, ABT, David vs Goliath), and ~90-120s micro-resets.
5. **Synthesize** voice via Edge TTS and upload the MP3 to Supabase Storage.

```
Topic Discovery ─► /analytics?episode=Ep-01 ─► Script Studio
[paste URLs]       [Firecrawl + Mistral per topic]    [edit script]
[select stories]   [edit briefs]                   [generate audio]
[Analyze Topics]   [Generate Script ↗]             [publish]
```

## Stack

| Layer            | Choice                                                       |
| ---------------- | ------------------------------------------------------------ |
| Framework        | Next.js 16 (App Router, Turbopack)                           |
| UI               | Tailwind v4, Lucide icons                                    |
| Database/Storage | Supabase (Postgres + Storage bucket)                         |
| Web search       | Firecrawl (`/api/analytics`)                                 |
| Reasoning model  | `mistralai/mistral-large-3-675b-instruct-2512` via NVIDIA NIM |
| Script writer    | Llama 3 70B (English) or Sarvam-M (Tenglish) via NVIDIA NIM  |
| TTS              | Microsoft Edge TTS — `en-US-AndrewNeural`                    |
| Article scraping | jsdom + Mozilla Readability                                  |

## Required accounts & keys

All have free tiers.

| Service                            | What you need                                            | Where                |
| ---------------------------------- | -------------------------------------------------------- | -------------------- |
| Supabase                           | Project URL + service-role key + an `audio` storage bucket | https://supabase.com |
| NVIDIA Build (NIM)                 | API key (free, generous limits)                          | https://build.nvidia.com |
| Firecrawl                           | API key (monthly quota)                                  | https://firecrawl.dev |
| Render                             | Free account                                             | https://render.com   |

Drop all of them into `.env` locally — see `.env.example` for the exact keys.

## Database setup

Run `supabase/schema.sql` in the Supabase SQL Editor (one click in their dashboard). If you already had an older version of the schema, the migration block at the bottom of that file lists the `ALTER TABLE` statements to bring the `updates.analysis_json` column in.

Then create a public storage bucket called `audio` (Storage → New bucket → name `audio` → Public). The TTS route uploads generated MP3s there and stores the public URL on the episode row.

## Local development

```bash
git clone <your-fork>
cd techx_tv
npm install
cp .env.example .env     # fill in your keys
npm run dev
```

Open http://localhost:3000.

Locally the `/api/analyze` route runs the NVIDIA call inline (fire-and-forget) and triggers its own callback on `127.0.0.1:$PORT`, so you don't need QStash.

## Deploying to Render (free tier)

This is what you want for production. Render's free web service has no per-request timeout (unlike Vercel Hobby's 60s), which matters because `/api/tts` synthesizes audio over a 5-minute websocket.

### 1. Push to GitHub

`.env` is gitignored — `.env.example` is the template that gets committed.

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<you>/techx-tv.git
git push -u origin main
```

### 2. Create the Render service

**Option A — Blueprint (one-click using the committed `render.yaml`):**

1. Render dashboard → **New +** → **Blueprint**
2. Connect your GitHub repo → Apply
3. Render reads `render.yaml`, provisions the service, then prompts you for the four secrets

**Option B — Manual web service:**

1. Render dashboard → **New +** → **Web Service** → connect the repo
2. Settings:
   - **Environment**: Node
   - **Build command**: `npm ci && npm run build`
   - **Start command**: `npm start`
   - **Plan**: Free
   - **Region**: Singapore (or whichever is closest to your users)
   - **Health check path**: `/`
3. Under **Environment** → add these vars (paste from your local `.env`):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `NVIDIA_API_KEY`
   - `FIRECRAWL_API_KEY`
   - `NODE_VERSION` = `20`
4. Click **Create Web Service**. First build takes ~3-5 min.

After it builds, the app is live at `https://techx-tv.onrender.com` (or whatever default name Render gives).

### 3. Point `tv.thetechx.in` at Render

**On Render:**

1. Open the service → **Settings** → **Custom Domains** → **Add Custom Domain**
2. Enter `tv.thetechx.in`
3. Render shows you a CNAME target — something like `techx-tv.onrender.com`. Copy it.

**On your `thetechx.in` DNS provider** (wherever you registered the domain — Hostinger, Namecheap, Cloudflare, etc.):

| Type  | Name | Value                          | TTL  |
| ----- | ---- | ------------------------------ | ---- |
| CNAME | `tv` | `techx-tv.onrender.com` *(or the exact target Render gave you)* | Auto |

If your registrar is Cloudflare, set the proxy status to **DNS only** (grey cloud) the first time so Render can issue the TLS cert. You can re-enable the orange proxy after the cert is verified — but then Cloudflare's free WebSocket support kicks in, which works for our use case.

Wait 1-15 minutes for DNS propagation. Render auto-issues a Let's Encrypt cert as soon as it sees the CNAME pointing to it. The custom-domain row turns green when ready.

### 4. About the free tier's cold starts

Free Render services sleep after **15 minutes of inactivity**. The next request wakes the container — usually ~30s cold start. For a personal podcast tool you operate by hand a few times a week, that's a tolerable trade-off.

If the cold start annoys you:

- Upgrade the service to **Starter ($7/mo)** — always on.
- Or keep it free and ping `/api/health`-style endpoint with a cron-style service like UptimeRobot / cron-job.org every 10 minutes.

### 5. (Optional) Vercel instead

You can run this on Vercel, but the free Hobby plan caps server functions at **60s**, which kills `/api/tts` (5-min synthesis) and batch `/api/analytics` calls. If you really want Vercel, either:

- Pay $20/mo for Pro (lifts `maxDuration` to 300s), or
- Set `QSTASH_TOKEN` (free at https://upstash.com) — the `/api/analyze` route already supports the queued pattern. You'd still need to refactor `/api/tts` and `/api/analytics` to use queues, which is real work.

## Project layout

```
app/
  page.tsx                 Topic Discovery — paste URLs, select stories, → Analyze
  analytics/page.tsx       Per-topic editable briefs, → Generate Script
  script-studio/page.tsx   Edit script, generate audio
  episodes/page.tsx        Browse past episodes
  api/
    scrape/route.ts        URL → article title + content (Readability)
    analytics/route.ts     Topic → Firecrawl search → Mistral Large 3 → structured brief
    analyze/route.ts       Selected topics + briefs → flowing podcast script
    tts/route.ts           Script → MP3 → Supabase Storage
  actions/
    updates.ts             Topic CRUD (server actions)
    episodes.ts            Episode CRUD
supabase/
  schema.sql               Tables, RLS policies, migration notes
```

## Troubleshooting

| Symptom                                          | Likely cause                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Analytics page hangs forever                     | `FIRECRAWL_API_KEY` or `NVIDIA_API_KEY` missing on the server. Check Render env. |
| `TTS API Error: Timed out`                       | Already fixed — TTS route uses 5-min timeout. If it recurs, the script is very long; chunk it or upgrade Render plan. |
| Script never appears in Script Studio after generate | Open Render → Logs. Look for `[Analyze]` lines — NVIDIA model errors print there. |
| Audio button does nothing                        | The Supabase `audio` bucket is missing or isn't public.                       |
| Custom domain stays "Issuing certificate"        | DNS hasn't propagated, OR Cloudflare proxy is on too early. Set grey-cloud / DNS-only, wait 5 min. |
| Local self-callback fails (`ECONNREFUSED`)       | `PORT` env var doesn't match the port Next is bound to. Defaults to 3000.    |

## License

Personal project — no license declared.
