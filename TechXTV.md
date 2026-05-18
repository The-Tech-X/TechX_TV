# TechXTV

## 1. Introduction

### 1.1 Purpose

TechXTV, The TechX Podcast Automator is an end-to-end dashboard designed to automate the research, analysis, and script-writing process for a weekly tech deep-dive podcast. It focuses on high-level technical analysis (the 'Why' and 'Impact') rather than simple news summaries.

### 1.2 Scope

The system handles:

- Automated fetching of tech news from specific URLs and RSS feeds.
- A curation dashboard for manual selection of topics.
- Multi-layered AI analysis for deep-dive insights.
- Collaborative script editing.
- Audio generation using free-tier TTS or manual recording.
- Metadata management for YouTube and Spotify distribution.

---

## 2. System Architecture

### 2.1 Tech Stack (Zero-Cost Focus)

- **Frontend/Backend:** Next.js (App Router) hosted on Vercel.
- **Database & Auth:** Supabase (PostgreSQL + Auth + Storage).
- **Background Orchestration:** Upstash QStash (to handle long-running AI tasks without Vercel timeouts).
- **Search/Research Engine:** Tavily API (1,000 free searches/month).
- **Inference Engines (free via NVIDIA NIM):**
  - **English scripts:** Llama-3.1-70B-Instruct (high-reasoning English analysis).
  - **Tenglish scripts:** Sarvam-M (Indic LLM with native code-mixed Romanized Telugu support).
  - Both share the same NIM API key and OpenAI-compatible endpoint — only the `model` field and system prompt differ.
- **Voice Synthesis:** Edge-TTS (Free via serverless function) or Web MediaStream API for manual recording.

### 2.2 System Diagram (Logic Flow)

1. **Trigger:** Weekly cron or manual button.
2. **Fetch:** Tavily/RSS pulls raw data -> Supabase.
3. **Curation:** User selects 'Top 5' stories via Dashboard.
4. **Analysis:** Background Task (QStash) triggers AI agents to perform detailed 'Impact Analysis'.
5. **Scripting:** AI compiles analysis into a conversational script -> Saved to Supabase.
6. **Finalize:** User edits script -> Generates/Records Audio.

---

## 3. Functional Requirements

### 3.1 Topic Discovery & Selection

- **FR1:** The system shall fetch tech updates from specified URLs and general RSS feeds.
- **FR2:** The dashboard shall display a list of fetched items with 'Select' and 'Dismiss' toggles.
- **FR3:** The system shall allow users to manually input a URL or raw text for analysis.

### 3.2 AI Deep-Dive Analysis

- **FR4:** For selected topics, the system shall perform a three-tier analysis:
  - **What:** Technical summary of the update.
  - **Why:** Contextual background and the problem it solves.
  - **Effects:** Short-term changes and long-term industry impact.
- **FR5:** The system shall utilize Llama-3 or similar high-parameter models via NVIDIA NIM for high-reasoning output.

### 3.3 Script Studio

- **FR6:** The system shall generate a full podcast script based on analyzed topics.
- **FR7:** The script editor shall support Markdown and real-time auto-save to Supabase.
- **FR8:** The system shall provide a 'Tone Selector' (e.g., Professional, Casual, Hype).
- **FR11:** The system shall provide a **Script Language selector** at episode generation time with two options:
  - **English** → routes to Llama-3.1-70B-Instruct via NVIDIA NIM (pure English script).
  - **Tenglish** → routes to Sarvam-M via NVIDIA NIM (naturally spoken Romanized Telugu mixed with English tech words; no Telugu-script characters).
  - The selected language is passed in the `/api/analyze` request body as `language: 'english' | 'tenglish'`, and the route branches the model ID and system prompt accordingly. Both options remain on the free NIM tier.

### 3.4 Media Production

- **FR9:** The system shall integrate Edge-TTS to convert finalized scripts into audio files at no cost.
- **FR10:** The dashboard shall include a 'Record' module for the user to speak and save their own audio.

---

## 4. Data Model (Supabase Schema)

### 4.1 Table: `updates`

- `id`: UUID (Primary Key)
- `title`: Text
- `url`: Text
- `source`: Text
- `status`: Enum (pending, selected, dismissed)
- `created_at`: Timestamp

### 4.2 Table: `episodes`

- `id`: UUID (Primary Key)
- `week_number`: Integer
- `topics`: JSONB (Array of selected updates)
- `script_content`: Text
- `analysis_data`: JSONB
- `audio_url`: Text
- `published_status`: Boolean

---

## 5. Non-Functional Requirements

- **Cost:** Operating costs must remain within the free tiers of Vercel, Supabase, and Upstash.
- **Performance:** Long-running AI analysis must be decoupled from the UI using background queues to prevent timeout errors.
- **Usability:** The dashboard must be responsive (Mobile/Desktop) for quick review on the go.

---

## 6. UI/UX Design Goals

- **Clean Sidebar Navigation:** Dashboard, Topic Discovery, Script Studio, Archive.
- **Status Indicators:** Clear badges for 'Analyzed', 'Recording Ready', and 'Published'.
- **Dark Mode Support:** Defaulting to a technical 'Midnight' theme to match The TechX branding.

