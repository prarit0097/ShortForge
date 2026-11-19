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

- **Local processing** — handles 1–10 GB source files directly from disk. Optional OpenRouter enrichment asks before sending still frames or enabled transcript excerpts.
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
- **Reframing** — **Fill screen** (crop sides, full-screen — the default), AI smart fill
  (keeps the subject), or Blurred pad (shows the whole scene with blurred bars).
- **Output quality** — High (near-original, default), Balanced, or Max. All output is
  forced to `yuv420p` so clips are accepted by every social platform. Lanczos scaling.
- **Enhance** (optional) — light denoise + sharpen + subtle colour pop for a crisper look.
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
   ─────────── "Analyze" returns the plan; UI shows the clip count ───────────
4. THUMBS      visible clip cards request preview frames in the background
5. AI ENRICH   (optional) local Whisper + approved OpenRouter still frames →
               title, caption, hashtags, virality score, smart-crop bias
6. CUT         ffmpeg per clip: reframe (blur/crop/smart) + AI title + captions,
               hardware-accelerated, run 2 clips in parallel, live progress
7. EXPORT      copy selected clips to your chosen folder (parallel, fast)
```

### The full-coverage segmentation algorithm (why no scene is missed)

Given the scene-change timestamps and your target/min/max length:

1. Candidate cut points = `[0, ...all scene changes inside the video, duration]`.
2. Starting at `0`, each segment extends toward `start + target`. It picks the closest scene
   boundary inside `[start+min, start+max]` that still leaves enough time to cover the remainder
   within those bounds. If no boundary qualifies, it uses the latest feasible cut.
3. If the duration makes both bounds impossible, the app uses the fewest clips that respect
   `max` and divides the time evenly. A video shorter than `min` stays in one clip.

Result: consecutive `[start,end]` pairs cover `0 → duration` without gaps or overlaps. The
planner uses scene boundaries where feasible. Run `npm test` to check cases such as dense
scenes, missing boundaries, subminimum sources, and the final remainder.

### Cutting (how a clip is rendered)

Each clip is built with a single FFmpeg `filter_complex` pipeline:

```
reframe (blur pad / center crop / smart crop)
   → AI hook title (drawtext, top of frame)      [only when AI layer is on]
   → burned captions (subtitles)                 [only when "Burn captions" is on]
```

- **Fill screen** (default) scales the scene to *cover* the whole output frame and crops the
  overflowing sides — a true full-screen short with no bars.
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
| Scene understanding | A scene clip sends one still frame per approved request. Gameplay clips can send three in chronological order so the model can use the lead-up and aftermath. |
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
│   ├── smoke-editor.js     Windows Electron workflow smoke with generated media
│   ├── icon.ico            App/installer icon (256×256)
│   └── icon.png            PNG copy of the icon
├── test/                   Node regression tests and FFmpeg media fixtures generated at runtime
└── src/
    ├── automation/                   ── Local CLI and MCP ──
    │   ├── cli.js                      Command-line analyze and render entry point
    │   ├── mcp-server.js               Four stdio MCP tools
    │   ├── automation.js               Shared automation operations and source-bound clip IDs
    │   ├── job-queue.js                Bounded work queue and job result retention
    │   ├── local-media.js              Approved-folder and media format validation
    │   └── schemas.js / errors.js     Tool parameter checks and public errors
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
    │       ├── pipeline.js            Analysis and rendering used by desktop and automation
    │       ├── highlights.js          Local motion, audio, and HUD-region scoring
    │       ├── link-import.js         YouTube and HTTP(S) video download, verification, and cache paths
    │       ├── highlight-enrichment.js  Gameplay shortlist and still frame sampling
    │       ├── projects.js            Save and reopen versioned local projects
    │       ├── watch-recordings.js    Quiet-period detection for completed recordings
    │       ├── thumbnails.js          Extracts one preview frame per clip (+ base64 for AI vision)
    │       ├── cutter.js              Builds the filter_complex (reframe + title + captions) and cuts all clips (parallel)
    │       ├── openrouter.js          AI layer: connection test, model list w/ pricing, per-clip enrichment
    │       ├── transcribe.js          Optional Whisper transcription → timestamped segments + SRT
    │       └── exporter.js            Batch copy of selected clips to the chosen folder
    └── renderer/                      ── UI (isolated web page, calls window.api) ──
        ├── index.html                 App structure (sidebar, import, settings, clip grid, modals)
        ├── styles.css                 Design system (dark "studio" theme, tokens, states)
        ├── editor.js                  Playback, markers, trim, and crop controls
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

The installer bundles Electron and FFmpeg/FFprobe. The core editor runs immediately after
installation. Optional captions need a compatible Whisper backend and a suitable model.

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
   if enabled), 2 at a time, with a live progress bar. The results show each failed clip and its
   error. Retry processes the selected clips that still need a render.
7. **Download** — Click **⬇ Batch download selected** and choose a folder. The export reports
   completed, failed, and cancelled copies. Cancellation lets active copies finish and stops
   the remaining queue. The exporter preserves existing filenames by choosing a unique name.

### Edit gameplay highlights

1. Import a finished OBS, capture-card, or console video. **Watch recordings** can monitor an OBS recording or replay-buffer folder for new files with 10 seconds of quiet. ShortForge lists ready files and imports the one you choose.
2. Select **Gameplay highlights** and click **Find highlights**. The local scan ranks up to 20 non-overlapping suggestions using low-resolution motion and changes in audio level. Changes in common HUD regions can boost a candidate that already has enough activity. The scan includes up to four seconds before the peak and six after. Use **Mark manually** or **Mark timestamp** in **Source preview** to add a moment yourself. If the original cannot play in the editor, **Generate playback preview** creates a short local H.264 proxy around the current position.
3. Use **Review clip** to play the range, edit its start and end, and set its horizontal crop. The caption safe-area guide shows where to position text for vertical delivery.
4. Choose **HUD-safe 9:16** to keep the full game frame inside a vertical canvas. Choose **Original 16:9** to keep a 16:9 recording at its original framing. For recordings with multiple audio tracks, select the game or mic track by name, mix the tracks, or mute the export. A playback proxy uses the selected track or mix.
5. Use **Render clip** for the current range. Edits flag the clip for rerendering and keep the previous render available for comparison. Batch export uses the currently rendered selections.
6. **Save project** writes a `.shortforge` file with the source path, selections, trims, crop, titles, and output settings. An unchanged source can reopen with still-available cached renders. The source video and rendered MP4 files stay on disk separately from the project file.

The local score measures activity. For optional semantic labels such as chase, near miss, crash, or stunt, use **Enhance with AI** on selected clips and approve the OpenRouter prompt. Each gameplay pass enriches up to ten candidates. The pass preserves manually edited titles and crops. **Share transcript context** is off by default. Turning it on lets a request include up to 800 characters of available transcript per clip. Local detection was tested with synthetic footage. GTA VI accuracy and dynamic subject tracking still require representative footage for calibration and review.

---

### Import a YouTube or direct video link

1. In **Video link**, paste a public YouTube watch, Shorts, or `youtu.be` URL, or a direct HTTP(S) video URL. Pasting starts the import and the local gameplay scan. If you type the link, select **Find highlights**.
2. To render as soon as the scan finishes, check **Auto-render HUD-safe 9:16** before pasting. ShortForge renders the suggested clips with full-width gameplay inside a vertical canvas. Review the results, then use **Batch download selected** to export to your folder.
3. Review, trim, or add a manual marker in the editor. If the scan finds no strong peaks, you can still mark a clip from the downloaded source. Cancelling a download or scan clears its staging files. After analysis, the downloaded recording stays in the app's `downloads` folder so saved projects can reopen it.

The Windows x64 build includes Deno. The first YouTube import downloads a pinned `yt-dlp` executable from GitHub, verifies its SHA-256 checksum, and caches it under `tools` in the app's user-data folder. YouTube support covers individual public recordings eligible for download. Account sign-in, DRM, playlists, and active live streams are outside this flow. YouTube may return an access error for particular videos. Direct URLs must return an MP4, MOV, MKV, WebM, AVI, FLV, or MPEG-TS file. The final recording limit is 10 GiB. YouTube can temporarily use extra disk space to merge separate video and audio streams. Highlight detection and auto-render run locally and skip OpenRouter enrichment.

## Local CLI and MCP setup

Automation runs locally from Node.js 18+ with the checkout's npm dependencies installed. It uses the same analysis and render pipeline as the desktop app. It uses CPU encoding and never calls OpenRouter or Whisper. Configure existing local input and output folders that you control. Keep them free of concurrent untrusted writers while automation is running.

```powershell
npm install
$env:SHORTFORGE_INPUT_ROOT = 'D:\OBS\Recordings'
$env:SHORTFORGE_OUTPUT_ROOT = 'D:\Shorts'
node src/automation/cli.js analyze 'session.mkv' --mode gameplay
$clipId = '<copy a segment ID from the result>'
node src/automation/cli.js render 'session.mkv' --mode gameplay --segments $clipId --aspect-ratio 9:16 --reframe-mode blur
```

Use the same source and analysis flags for both commands. A segment ID is tied to the source revision, settings, and exact range. The CLI rejects old IDs after the source or settings change. `--mode coverage` plans the full recording and accepts scene scan, threshold, and length options. `--mode gameplay` ranks local highlights. Use the returned relative artifact path under the output folder to find each MP4.

### Register ShortForge in Codex

From the checkout, run the following in PowerShell with your actual folder paths. The MCP server uses stdio. It has no listening port.

```powershell
$entry = (Resolve-Path '.\src\automation\mcp-server.js').Path
codex mcp add --env 'SHORTFORGE_INPUT_ROOT=D:\OBS\Recordings' --env 'SHORTFORGE_OUTPUT_ROOT=D:\Shorts' shortforge -- node $entry
codex mcp get shortforge
```

An installed or unpacked Windows build can use its bundled Node runtime. Set `$exe` to the actual `ShortForge.exe` path and use the script inside its sibling `resources` directory.

```powershell
$exe = 'C:\Path\To\ShortForge\ShortForge.exe'
$entry = Join-Path (Split-Path $exe) 'resources\app.asar\src\automation\mcp-server.js'
codex mcp add --env 'ELECTRON_RUN_AS_NODE=1' --env 'SHORTFORGE_INPUT_ROOT=D:\OBS\Recordings' --env 'SHORTFORGE_OUTPUT_ROOT=D:\Shorts' shortforge -- $exe $entry
```

| Tool | Inputs and result |
|---|---|
| `analyze_video` | Submit a source path relative to the input folder. Select `coverage` or `gameplay`. Returns a job ID. |
| `get_job` | Poll the job by ID. Returns state, progress, and analysis or render metadata when finished. |
| `render_clips` | Submit an `analysisId`, one to twenty `segmentIds`, and optional aspect ratio, reframe mode, and quality. Set `aspectRatio` to `9:16` and `reframeMode` to `blur` to preserve the game frame. |
| `cancel_job` | Cancel by job ID. Pending work stops, and the running stage settles before the slot is reused. |

The server retains 32 finished jobs during its lifetime. It accepts sources up to eight hours or 64 GiB, with at most 1,000 planned clips. Results contain timestamps, IDs, and relative output paths. Frames, transcripts, API keys, and absolute paths stay out of tool results. The MCP client can pass returned metadata to its model.

---

## 11. Settings explained

**Cutting settings (main screen):**
- **Target / Min / Max length** — desired clip length and the allowed band.
- **Output ratio** — 9:16 / 16:9 / 1:1 / 4:5 / original.
- **Reframe** — **Fill screen** (crop sides, full-screen — default) / AI smart fill (keeps
  subject, needs AI) / Blurred pad (whole scene with bars).
- **Scene scan** — Accurate (ffmpeg scene detect) or Fast (keyframes, for huge files).
- **Scene sensitivity** — 0.15 (more cuts) … 0.6 (only hard cuts). Default 0.40.
- **Output quality** — High (near-original, default) / Balanced (faster, smaller) / Max (best, slowest).
- **Enhance** — light sharpen + denoise + colour pop.
- **Burn AI hook title** — overlay the AI title on each clip (AI on). Default on.
- **Burn captions** — use local Whisper on the selected audio track or mix to create burned-in subtitles.

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

- **Captions need a compatible Whisper backend and model.** The Windows x64 package can use
  the native backend from `nodejs-whisper` 0.4.0. Where a backend is unavailable, the UI shows
  that captions cannot be generated and clips can still render. The selected model may download
  on first use and is saved under the app's user-data folder. Choose a multilingual model for
  non-English audio.
- "AI smart crop" only changes the frame in **crop** mode; in **blur** mode the whole frame is
  always shown, so crop bias has no visible effect there.
- Hardware encoders may be *listed* by FFmpeg but fail at runtime (no GPU/driver); the app
  probes them and falls back to CPU automatically.
- Very long movies with the "Accurate" scene scan take time to analyze (full decode); use
  "Fast (keyframes)" for huge files.

---

## 14. Security & privacy

- The source file, local highlight scan, renders, and exports stay on the PC. Approved OpenRouter
  enrichment can send still frames and, when separately enabled, a transcript excerpt.
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
| **1.0.4** | **Full-screen shorts by default** — default reframe changed from blurred-pad to **Fill screen** (crop sides), so 9:16 clips fill the whole frame with no blur bars. Reframe options relabelled/reordered; one-time settings migration moves existing installs off the old blur default. |
| **1.0.5** | **Output quality + 3-round hardening.** Added quality levels (High near-original default / Balanced / Max), forced `yuv420p` for platform compatibility (incl. Intel QSV), Lanczos scaling, and an optional Enhance (denoise+sharpen) filter. Then ran a deep multi-agent review **three times** (25 confirmed bugs found and fixed): real FFmpeg error messages, OpenRouter request+body timeouts, robust JSON parsing, per-thumbnail fault tolerance, a unified `CancelledError` (no more string-matching), `try/finally` on every IPC handler (no job leaks / stuck UI), bounded progress buffers immune to chunk splits, path-hash work dirs (no same-name collisions), honest Whisper availability, VFR fps sanity cap, font/path resilience, and a captions-skipped warning. |
| **1.0.6** | Clip plans redistribute short remainders and respect the maximum length. Render and export results report per-clip failures and cancellation, successful renders remain available, and selected failed cuts can be retried. Added a Node regression suite and an FFmpeg render smoke test. |
| **1.1.0** | Gameplay editor with source playback, manual highlights, clip review and trim, HUD-safe 9:16 and original framing, per-clip render, and project save/resume. Added audio track selection, mixing, and mute. Clip plans appear before lazy thumbnail generation. |
| **1.2.0** | Added ranked local gameplay suggestions, monitoring for finished recordings, and limited OpenRouter enrichment with chronological still frames, a per-batch consent prompt, and optional transcript context. |
| **1.3.0** | Added the local CLI and stdio MCP server, source-bound segment IDs, and job progress, cancellation, and result metadata for automation. Updated the optional Whisper backend and fixed subtitle timing at clip boundaries. |
| **1.4.0** | Paste a public YouTube or direct video link to download and scan for local gameplay highlights, with optional automatic HUD-safe 9:16 rendering. |

---

## Maintenance & workflow

### Gameplay workflow rollout

The goal is to take a local OBS, capture-card, or console recording from import to a reviewed gameplay short. ShortForge will retain full-coverage scene splitting and add manual and automatically suggested highlights. The desktop app and optional local MCP server will share the analysis and rendering services.

| Phase | Changes | Verification before publishing |
|---|---|---|
| 1. Reliable cuts and exports | Enforce clip length bounds where feasible while preserving coverage. Show per-clip outcomes, retain successful output, retry failures, and stop scheduling exports on cancellation. | Test tail redistribution, infeasible length ranges and tiny inputs. Exercise partial and total render failure, retries, cancellation, and export collisions. Run the regression suite and Windows packaging check. |
| 2. Gameplay editing | Show the plan ahead of thumbnails. Add playable source previews, manual timestamp markers, editable trims, per-clip rerendering, HUD-safe 9:16 and original 16:9 presets, crop and caption previews, and game/mic track controls. Save and resume projects. | Exercise import, playback, manual highlight, trim, save/reopen, single-clip rerender, and export. Use representative OBS MKV, phone MOV, silent clips, and timestamped TS where fixtures are available. |
| 3. Automatic highlights | Scan local footage for motion and audio signals, group overlapping moments and retain lead-up and reaction. Show ranked, editable candidates and support finalized replay-buffer or watch-folder imports. Apply optional OpenRouter enrichment to the shortlist after disclosing what leaves the machine. | Verify detection and ranking with labeled fixtures, review false positives and retained context, and measure scan and export time. Record proxy footage results separately from GTA VI footage validation. |
| 4. Local automation | Add a CLI and optional stdio MCP server for analysis, job status, selected rendering, and cancellation. Use per-job workspaces and local input/output directories approved in configuration. Return IDs, timestamps, and result metadata. | Test the tool protocol, concurrent jobs, local path boundaries, job cancellation, and playable outputs on Windows. |

Run the relevant tests at each phase, update this guide and changelog, then commit and push the verified phase. Confirm the commit on GitHub against the local commit hash.

**Phase 1 verification for 1.0.6.** All 16 tests passed in the staged source snapshot, and `npm run pack` produced the unpacked Windows app. The suite includes a generated OBS-style MKV, audio-only interval rejection, concurrent exports, cancellation, and a simulated destination without hard links. On volumes without hard links, export uses an exclusive copy and the final name can be visible while an active copy finishes.

**Phase 2 verification for 1.1.0.** All 23 tests passed in the staged source snapshot. The Windows Electron smoke test (`.\node_modules\.bin\electron.cmd build/smoke-editor.js`) used the real preload and IPC to import a generated two-track MKV, preview selected audio, mark and trim a highlight, render and rerender in 1080×1920, play the previous render at its original bounds, export, and reopen the project. The media tests cover rotated silent VFR MOV and nonzero-start MPEG-TS. The unpacked Windows build also passed.

**Phase 3 verification for 1.2.0.** All 39 tests passed in the staged snapshot, and the unpacked Windows build succeeded. The Electron smoke test found and ranked two labeled synthetic peaks, preserved a manual marker, prevented duplicates on rescan, and imported a watched recording only after a user action and at least ten seconds of quiet time. Watch events stopped when requested. OpenRouter requests were tested with a mocked service. No real GTA VI recordings were used.

**Phase 4 verification for 1.3.0.** All 47 regression tests passed. The Windows Electron smoke verified the editor, watcher, and AI consent via the real preload and IPC. The mocked OpenRouter service received no request on decline and three still frames on approval. Transcript text stayed out of the request with sharing off. `npm run dist -- --publish never` produced the unsigned NSIS installer. The unpacked `ShortForge.exe` passed a real MCP stdio handshake and rendered a playable 1080×1920 H.264 clip. The packaged Whisper backend also produced a timed transcript from synthetic speech. `npm audit --omit=dev` reported zero findings in the production npm dependency tree. A full audit continues to report findings in Electron and build tooling.

**Link import verification for 1.4.0.** All 50 regression tests passed. The Electron smoke test pasted a direct HTTP video, verified two suggestions, and repeated the import with auto-render enabled. FFprobe and FFmpeg confirmed playable 1080×1920 output. A public YouTube video was downloaded and scanned in both development and a packaged build. The packaged settings produced a playable 1080×1920 H.264 clip. One YouTube request returned HTTP 403 and a normal repeat request succeeded. Cancellation and staging cleanup are covered by tests against a partial HTTP response.

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
