# ShortForge — Complete Project Documentation

> **One file to understand the whole app.** What it is, why it exists, what it does,
> how it works internally, how the AI layer helps, pros & cons, how to build the `.exe`,
> and how to use it. Read this top-to-bottom and you'll know the entire project.
>
> ⚠️ **Maintenance rule:** This file MUST be updated after every change or modification
> to the app, and all changes pushed to git. See [Maintenance & Workflow](#maintenance--workflow).

---

## Table of Contents
1. [What is ShortForge?](#1-what-is-shortforge)
2. [Why this project was needed](#2-why-this-project-was-needed)
3. [What it does (features)](#3-what-it-does-features)
4. [How it works (pipeline)](#4-how-it-works-pipeline)
5. [The AI layer — what it does and how](#5-the-ai-layer--what-it-does-and-how)
6. [Tech stack](#6-tech-stack)
7. [Project structure — every file explained](#7-project-structure--every-file-explained)
8. [How to run (development)](#8-how-to-run-development)
9. [How to build the `.exe` installer](#9-how-to-build-the-exe-installer)
10. [How to use the app (step by step)](#10-how-to-use-the-app-step-by-step)
11. [Settings explained](#11-settings-explained)
12. [Pros & cons](#12-pros--cons)
13. [Known limitations](#13-known-limitations)
14. [Security & privacy](#14-security--privacy)
15. [Performance notes](#15-performance-notes)
16. [Changelog](#16-changelog)
17. [Maintenance & workflow](#maintenance--workflow)

---

## 1. What is ShortForge?

**ShortForge** is a lightweight **Windows desktop app** that takes a long video or movie
(1 GB–10 GB) and automatically cuts it into many **short clips** (e.g. 20–50 seconds each),
**scene-by-scene**, covering the *entire* video so **no scene is ever missed**.

It has an optional **AI layer** (powered by OpenRouter) that understands each scene, scores
how "viral" it is, writes catchy titles/captions/hashtags, and burns an AI hook title onto
the clips. Everything runs **locally on your PC** — your videos are never uploaded anywhere.

The output clips can be reframed to any aspect ratio (9:16 for Reels/Shorts/TikTok, 16:9,
1:1, 4:5) and batch-downloaded to a folder of your choice, with the option to pick exactly
which clips you want.

---

## 2. Why this project was needed

Turning a long video (a movie, lecture, podcast, or episode) into short-form clips is
normally:

- **Manual and slow** — scrubbing a timeline and cutting clips by hand takes hours.
- **Cloud-based and limited** — tools like Opus Clip / Klap upload your video to a server,
  cap file sizes, charge per minute, and raise privacy concerns for personal content.
- **Lossy on coverage** — most "AI highlight" tools only keep a few "best" moments and
  throw away the rest of the video.

ShortForge was built to solve exactly this:

- **Local & private** — handles huge 1–10 GB files directly from disk, nothing uploaded.
- **Full coverage** — the *whole* video becomes shorts; nothing is skipped.
- **Free core** — the cutting engine (FFmpeg) is free; AI is optional and pay-per-use only
  if you turn it on.
- **One-click batch** — analyze → process → download all clips at once.

---

## 3. What it does (features)

**Core (no AI required):**
- Import any video/movie: MP4, MKV, MOV, AVI, WEBM, M4V, FLV, WMV, TS, MPG/MPEG.
- Drag-and-drop or browse. Reads 1–10 GB files from disk (never loaded into RAM).
- **Analyze before cutting** — detects scene changes and shows *how many shorts* you'll get
  for your chosen length, **before** any processing starts.
- **Full-coverage, scene-aware cutting** — splits the entire video into consecutive shorts of
  your target length, snapped to real scene boundaries. No gaps, no overlaps, nothing skipped.
- **Output ratio dropdown** — 9:16, 16:9, 1:1, 4:5, or original.
- **Reframing** — blurred-pad (nothing cropped), center crop, or AI smart crop.
- **Hardware-accelerated encoding** — auto-detects NVIDIA NVENC / Intel QuickSync / AMD AMF,
  falls back to CPU (libx264).
- **Live progress + cancel** for every stage.
- **Per-clip selection** — pick which shorts to keep, rename them inline, hover to preview.
- **Batch download** — export all selected clips to a chosen folder (fast local copy, parallel).

**AI layer (optional, toggle on/off, needs an OpenRouter key):**
- Scene understanding (vision) → one-line description per clip.
- **Virality score (0–100)** → rank/filter your best clips ("Top 10 by score").
- Auto **title, caption, hashtags** per clip.
- **AI hook title burned onto the video** (the main visible AI difference).
- **Smart crop** hint (keeps the subject in frame when reframing in crop mode).
- **Whisper transcription** (bundled) → optional burned-in captions, multilingual.
- **Model picker with live pricing** → choose any OpenRouter model, sorted cheapest-first,
  with a ⭐ recommended cheap-but-reliable default.

---

## 4. How it works (pipeline)

The app runs a multi-stage pipeline. Stages 1–4 are the **Analyze** step; stage 5 (AI) is
optional; stage 6 is **Process**; stage 7 is **Download**.

```
1. PROBE       ffprobe → duration, resolution, fps, codec, audio, size
2. SCENES      ffmpeg scene filter → list of scene-change timestamps
               (or fast keyframe-only scan for very large files)
3. SEGMENT     full-coverage algorithm → consecutive [start,end] clips
4. THUMBS      one preview frame per clip (for the UI grid)
   ─────────── "Analyze" finishes here; UI shows "N shorts planned" ───────────
5. AI ENRICH   (optional) Whisper transcript + OpenRouter vision per clip →
               title, caption, hashtags, virality score, smart-crop bias
6. CUT         ffmpeg per clip: reframe (blur/crop/smart) + AI title + captions,
               hardware-accelerated, run 2 clips in parallel, live progress
7. EXPORT      copy selected clips to your chosen folder (parallel, fast)
```

### The full-coverage segmentation algorithm (why no scene is missed)

Given the scene-change timestamps and your target/min/max length:

1. Candidate cut points = `[0, ...all scene changes inside the video, duration]`.
2. Starting at `0`, each segment extends toward `start + target`. Among the scene boundaries
   that fall inside the allowed band `[start+min, start+max]`, it picks the one **closest to
   the target**. If no boundary falls in the band, it **hard-splits at `max`** (never exceeds).
3. The final short tail (shorter than `min`) is **merged into the previous segment**.

Result: consecutive `[start,end]` pairs that cover `0 → duration` with **no gaps and no
overlaps**, each near your target length, cut on real scene boundaries when possible. This is
unit-tested across edge cases (dense scenes, sparse scenes, no scenes, tiny video, 2-hour movie).

### Cutting (how a clip is rendered)

Each clip is built with a single FFmpeg `filter_complex` pipeline:

```
reframe (blur pad / center crop / smart crop)
   → AI hook title (drawtext, top of frame)      [only when AI layer is on]
   → burned captions (subtitles)                 [only when "Burn captions" is on]
```

- **Blur pad** blurs a *downscaled* copy of the frame and upscales it (≈5× faster than
  blurring the full-size frame, visually identical background).
- Cuts use **input seeking before `-i` with re-encode**, which is both fast and
  frame-accurate.
- The encoder is chosen by hardware detection (NVENC → QSV → AMF → libx264).

---

## 5. The AI layer — what it does and how

The AI layer is **off by default** and toggled from the sidebar. It needs a free/paid
**OpenRouter** API key (set in Settings). All AI calls happen in the **main process** so your
key never reaches the web UI.

| AI feature | How it's implemented |
|---|---|
| Scene understanding | A keyframe (thumbnail) of each clip is sent to an OpenRouter **vision** model. |
| Title / caption / hashtags | Same vision call returns strict JSON with these fields. |
| Virality score (0–100) | The model rates how engaging/shareable each clip is; used for ranking. |
| Smart crop | The model reports the subject's horizontal position (-1..1); used as crop bias in crop mode. |
| Burned hook title | The AI title is wrapped and drawn onto the video with FFmpeg `drawtext`. |
| Captions / subtitles | Bundled **Whisper** (`nodejs-whisper`) transcribes the audio; an SRT is burned in. |
| Model picker | OpenRouter `/models` is fetched live; models are shown with per-million-token pricing, sorted cheapest-first, with a ⭐ curated recommendation. |

**Why "AI on" now visibly changes the output:** earlier the AI only changed metadata
(titles/scores), so in blur mode with captions off the rendered pixels were identical to a
non-AI render. Now, when the AI layer is on, the app **auto-enhances** before processing and
**burns the AI hook title** onto each clip — a clear, language-agnostic visible difference.

**Recommended models (cheap + reliable):**
- Vision: `google/gemini-2.5-flash-lite` (~$0.10/M input)
- Text: `mistralai/mistral-small-3` or `google/gemini-2.5-flash-lite`

The picker also shows free models (labelled `FREE`) and the absolute cheapest, but the ⭐
recommendation deliberately avoids unreliable free/utility models (e.g. moderation- or
music-only models that would break scene analysis).

---

## 6. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron 33** | Cross-process desktop app; easiest reliable Windows build (just needs Node). |
| UI | **Vanilla HTML/CSS/JS** (no framework) | Lightweight, zero build step, fewer moving parts. |
| Video engine | **FFmpeg / FFprobe** (`ffmpeg-static`, `ffprobe-static`) | Bundled binaries; all cutting/scene-detection/encoding. |
| Transcription | **Whisper** (`nodejs-whisper`, optional) | Local, offline, multilingual captions. |
| AI | **OpenRouter** REST API (built-in `fetch`) | One key → many vision/text models with transparent pricing. |
| Packaging | **electron-builder** (NSIS) | Produces a Windows installer. |
| Secrets | Electron **safeStorage** (Windows DPAPI) | API key encrypted at rest. |

No heavyweight dependencies: settings/concurrency/HTTP are all done with Node built-ins.

---

## 7. Project structure — every file explained

```
videocutapp/
├── package.json            App metadata, scripts (start/pack/dist), electron-builder config
├── package-lock.json       Locked dependency tree
├── README.md               Short readme
├── videocut.md             THIS file — full documentation
├── LICENSE                 MIT
├── .gitignore              Ignores node_modules/, dist/, logs, whisper models, work dirs
├── build/
│   ├── make-icon.js        Generates icon.ico (gradient + play mark) with no image deps
│   ├── icon.ico            App/installer icon (256×256)
│   └── icon.png            PNG copy of the icon
└── src/
    ├── main/                          ── Electron MAIN process (Node, full access) ──
    │   ├── main.js                    App entry: creates the window, lifecycle, debug logging
    │   ├── preload.js                 Secure contextBridge: exposes a whitelisted `window.api`
    │   ├── ipc.js                     Orchestrates the whole pipeline (analyze/enrich/process/export) + IPC handlers
    │   ├── binaries.js                Resolves bundled ffmpeg/ffprobe paths (dev + packaged/asar)
    │   ├── constants.js               Aspect ratios, reframe modes, default settings
    │   ├── settings.js                JSON settings store + API key encrypted with safeStorage
    │   ├── jobs.js                    Tracks child processes per job for progress + cancel
    │   └── services/
    │       ├── ffmpeg-util.js         spawn helpers: ffprobe JSON, run ffmpeg with progress parsing
    │       ├── hwaccel.js             Detects usable NVENC/QSV/AMF encoder (real probe) + flags
    │       ├── probe.js               Reads video metadata via ffprobe
    │       ├── scenes.js              Scene-change detection + fast keyframe fallback
    │       ├── segmenter.js           Full-coverage segmentation algorithm
    │       ├── thumbnails.js          Extracts one preview frame per clip (+ base64 for AI vision)
    │       ├── cutter.js              Builds the filter_complex (reframe + title + captions) and cuts all clips (parallel)
    │       ├── openrouter.js          AI layer: connection test, model list w/ pricing, per-clip enrichment
    │       ├── transcribe.js          Optional Whisper transcription → timestamped segments + SRT
    │       └── exporter.js            Batch copy of selected clips to the chosen folder
    └── renderer/                      ── UI (sandboxed web page, talks only via window.api) ──
        ├── index.html                 App structure (sidebar, import, settings, clip grid, modals)
        ├── styles.css                 Design system (dark "studio" theme, tokens, states)
        └── renderer.js                All UI logic: import, settings, analyze, AI enhance, process, export
```

**Process model:** The **renderer** (UI) has no Node access. It calls `window.api.*` which the
**preload** bridges to the **main** process over IPC. Heavy work (FFmpeg, Whisper, OpenRouter,
the API key) lives only in main. This keeps the app secure and the UI responsive.

---

## 8. How to run (development)

Requirements: **Windows 10/11**, **Node.js 18+**.

```bash
npm install      # fetches Electron + ffmpeg/ffprobe binaries (+ optional Whisper)
npm start        # launches the app
```

That's it — the window opens. The AI layer is off until you enable it and add a key.

> If you ever see an `ELECTRON_RUN_AS_NODE` error, it means that environment variable is set
> in your shell; open a fresh terminal (it should not be set normally).

---

## 9. How to build the `.exe` installer

```bash
npm run dist
```

This runs **electron-builder** and produces a Windows **NSIS installer** in `dist/`:

```
dist/ShortForge Setup <version>.exe     ← the installer (~190 MB, share this)
dist/win-unpacked/ShortForge.exe        ← portable build (runs without installing)
```

The installer bundles everything (Electron + FFmpeg + Whisper), so the target PC needs
**nothing else installed**.

- The app icon comes from `build/icon.ico` (regenerate with `node build/make-icon.js`).
- The build is **not code-signed** (signing needs a paid certificate), so Windows SmartScreen
  may warn on first run → **"More info" → "Run anyway"**.
- `npm run pack` builds the unpacked app only (no installer), useful for quick testing.

---

## 10. How to use the app (step by step)

1. **Import** — Click **＋ Add Video** (or drag a file onto the dropzone). The file card shows
   duration, resolution, fps, size, audio.
2. **Settings (cutting)** — Set **Target / Min / Max length** (e.g. 30 / 20 / 50 s), pick the
   **Output ratio** (e.g. 9:16), **Reframe** (Blur pad), and **Scene scan** (Accurate).
   Optionally tick **Burn AI hook title** / **Burn AI captions**.
3. **Analyze** — Click **Analyze video →**. The app detects scenes and shows **"N shorts
   planned"** with a thumbnail grid — *before* any cutting.
4. **(Optional) AI** — Turn on **AI Layer** in the sidebar, set your OpenRouter key in
   **⚙ Settings**, then click **✨ Enhance with AI** to score/title every clip. (If AI is on,
   processing will auto-enhance for you.)
5. **Select** — Tick/untick clips, rename titles inline, or use **Select all / None / Top 10
   by score**.
6. **Process** — Click **▶ Start processing**. Clips are cut with reframing (+ AI title/captions
   if enabled), 2 at a time, with a live progress bar.
7. **Download** — Click **⬇ Batch download selected**, choose a folder, and all selected clips
   are exported there.

---

## 11. Settings explained

**Cutting settings (main screen):**
- **Target / Min / Max length** — desired clip length and the allowed band.
- **Output ratio** — 9:16 / 16:9 / 1:1 / 4:5 / original.
- **Reframe** — Blur pad (nothing cropped) / Center crop / AI smart crop.
- **Scene scan** — Accurate (ffmpeg scene detect) or Fast (keyframes, for huge files).
- **Scene sensitivity** — 0.15 (more cuts) … 0.6 (only hard cuts). Default 0.40.
- **Burn AI hook title** — overlay the AI title on each clip (AI on). Default on.
- **Burn AI captions** — burn Whisper subtitles (needs AI + Whisper).

**Settings modal (⚙):**
- **OpenRouter API key** — Save / Test. Stored encrypted (DPAPI).
- **Vision / Text model** — dropdowns with live pricing, cheapest-first, ⭐ recommended.
- **Whisper model** — `tiny/base/small/medium` (multilingual) or `*.en` (English-only).
- **Hardware encoder** — Auto / NVENC / QSV / AMF / CPU.
- **Parallel exports** — how many clips copy at once during download.

---

## 12. Pros & cons

**Pros**
- ✅ Fully **local & private** — no uploads, handles 1–10 GB files.
- ✅ **Full coverage** — nothing skipped, scene-accurate cuts.
- ✅ **Free core** — FFmpeg does the heavy lifting; AI is optional.
- ✅ **Hardware accelerated** + parallel cutting for speed.
- ✅ **Flexible output** — any ratio, blur/crop/smart reframe, captions, AI titles.
- ✅ **Transparent AI** — pick any model, see exact pricing, cheap recommended default.
- ✅ One-click **batch export** with per-clip selection.

**Cons**
- ⚠️ **Windows-only** (uses Windows fonts + targets an NSIS installer).
- ⚠️ Installer is **large (~190 MB)** because it bundles Electron + FFmpeg + Whisper.
- ⚠️ **Re-encoding is CPU/GPU heavy** — many clips on a CPU-only machine can take a while.
- ⚠️ **AI costs money** per clip (small, but 100 clips = 100 vision calls).
- ⚠️ **Whisper captions** need the right model for non-English audio, and add processing time.
- ⚠️ **Not code-signed** → SmartScreen warning on first run.

---

## 13. Known limitations

- Captions quality depends on the Whisper model + language (use a multilingual model, not
  `*.en`, for non-English audio).
- "AI smart crop" only changes the frame in **crop** mode; in **blur** mode the whole frame is
  always shown, so crop bias has no visible effect there.
- Hardware encoders may be *listed* by FFmpeg but fail at runtime (no GPU/driver); the app
  probes them and falls back to CPU automatically.
- Very long movies with the "Accurate" scene scan take time to analyze (full decode); use
  "Fast (keyframes)" for huge files.

---

## 14. Security & privacy

- **No uploads** — videos are read from disk and processed locally; only AI *thumbnails/text*
  (if you enable AI) are sent to OpenRouter.
- **API key** is encrypted at rest with Windows DPAPI (`safeStorage`) and used only in the
  main process — it never reaches the web UI.
- **Renderer is locked down** — `contextIsolation: true`, `nodeIntegration: false`, a strict
  Content-Security-Policy, and a whitelisted IPC surface.

---

## 15. Performance notes

- **Blur pad is optimized** — blurring a downscaled copy then upscaling is ≈5× faster than
  blurring the full-size frame (≈50 s → ≈10 s per clip in testing) with no visible difference.
- **Clips are cut 2 at a time** (configurable) — extra throughput on top of FFmpeg's own
  multithreading.
- **Live within-clip progress** via `-progress pipe:1` — the bar always moves, so a slow
  render never looks frozen.
- **Hardware encoding** (NVENC/QSV/AMF) offloads the encode when a working GPU is present.
- For huge files, **Fast (keyframe) scan** avoids a full decode during analysis.

---

## 16. Changelog

| Version | Changes |
|---|---|
| **1.0.0** | First release: import, scene detection, full-coverage segmentation, blur/crop reframe, ratio dropdown, AI enrichment (titles/score/hashtags/smart-crop), Whisper captions, batch export, NSIS installer + icon. |
| **1.0.1** | **Bug fix:** dead UI — a top-level `const api` collided with the contextBridge global, crashing the renderer; wrapped the renderer in an IIFE and removed CSP-blocked inline handlers. |
| **1.0.2** | **Performance:** optimized blur (downscale→blur→upscale, ≈5×), added live within-clip progress (`-progress pipe:1`), parallel cutting (2 concurrent), cancel-aware. |
| **1.0.3** | **AI model picker** with live OpenRouter pricing, cheapest-first, ⭐ curated recommendation (filters out dynamic-priced routers and unreliable free models). **AI now visibly changes output:** burns the AI hook title onto clips, auto-enhances before processing, multilingual Whisper default. |

---

## Maintenance & workflow

**This is a standing rule for this project:**

1. **After every change or modification** to the app, update this `videocut.md` so it always
   reflects the current state (features, behaviour, structure, changelog).
2. Bump the version in `package.json` when the build changes, and add a row to the
   [Changelog](#16-changelog).
3. **Commit and push everything to git** after the change.

**Git policy:** source code is committed; `node_modules/` and `dist/` (including the `.exe`)
are **git-ignored** (binaries are rebuilt with `npm run dist`, not stored in git, because
GitHub rejects files over 100 MB). To distribute the installer, attach it to a GitHub Release.

```bash
# typical change → ship loop
# (edit code / docs)
npm run dist                 # rebuild the installer if needed
git add -A
git commit -m "feat|fix|...: short description"
git push
```
