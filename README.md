# ShortForge 🎬→📲

A lightweight **Windows desktop app** that turns long videos and movies (1 GB–10 GB) into
short clips **scene-by-scene with full coverage** — nothing gets skipped. Optional **AI layer**
(OpenRouter) adds scene understanding, virality scoring, auto titles/captions/hashtags and
smart subject-tracking crop. Everything runs **locally** on your PC — no uploads.

## Features

- **Import** any video/movie (MP4, MKV, MOV, AVI, WEBM, …). Drag-drop or browse. Handles huge files (read from disk, never loaded into RAM).
- **Analyze before cutting** — detects scene changes, then shows *exactly how many shorts* you'll get from your target length, before any processing starts.
- **Full-coverage, scene-aware cutting** — the whole video is split into consecutive shorts of your chosen length (e.g. 20–50 s), snapped to real scene boundaries. No scene is missed; no gaps or overlaps.
- **Output ratio dropdown** — 9:16, 16:9, 1:1, 4:5, or original.
- **Reframing** — blurred-pad (nothing cropped), center crop, or AI smart crop.
- **Hardware-accelerated** encoding — auto-detects NVIDIA NVENC / Intel QSV / AMD AMF, falls back to CPU.
- **AI Layer (toggle on/off)** via OpenRouter:
  - Scene description + **virality score** (rank/filter your best clips)
  - Auto **title, caption, hashtags** per clip
  - **Smart crop** hint (keeps the subject in frame when reframing)
  - **Whisper transcription** → optional burned-in captions + transcript-aware titles
- **Per-clip selection** — pick exactly which shorts to keep, rename them inline, preview on hover.
- **Batch download** — export all selected shorts to a folder you choose, fast (local file copy, concurrent).
- **Cancel any time** with live progress for every stage.

## Requirements

- **Windows 10/11**
- **Node.js 18+** (only needed to run/build — end users of a packaged build don't need it)
- FFmpeg/FFprobe are bundled automatically via `ffmpeg-static` / `ffprobe-static` (npm install fetches them).
- (Optional) An **OpenRouter API key** for the AI layer — get one at https://openrouter.ai/keys

## Run it

```bash
npm install
npm start
```

That's it. The app window opens.

> The AI layer is **off by default**. Turn it on with the **AI Layer** toggle in the sidebar,
> then add your OpenRouter key in **⚙ Settings**.

## Build a Windows installer

```bash
npm run dist
```

Produces an NSIS installer in `dist/`. (Add `build/icon.ico` for a custom icon.)

## How cutting works (so no scene is missed)

1. **Scene detection** — FFmpeg scene filter finds every scene-change timestamp (tunable sensitivity).
   For very large files, a fast keyframe-only scan is available.
2. **Full-coverage segmentation** — starting at 0, each segment extends toward your *target* length and
   snaps to the nearest scene boundary inside your *min–max* band. If no boundary falls in range it
   hard-splits at *max*. The final short tail is merged into the previous clip. Result: the entire
   video from `0 → end` is covered with no gaps or overlaps.
3. **Cutting** — each segment is re-encoded with frame-accurate seeking (so cuts are exact), reframed
   to your chosen ratio, optionally captioned, using hardware acceleration when available.

## Whisper (captions / transcript)

Captions and transcript-aware titles use a **bundled local Whisper** (`nodejs-whisper`, an optional
dependency). If it isn't installed/built on your machine, the core app still works fully — only the
audio-transcript features are skipped. Model is selectable in Settings (`base.en` default).

## Project structure

```
src/
  main/
    main.js            app entry + window
    preload.js         secure contextBridge API
    ipc.js             pipeline orchestration (analyze/enrich/process/export)
    binaries.js        ffmpeg/ffprobe path resolution (dev + packaged)
    settings.js        JSON settings + encrypted API key (safeStorage)
    jobs.js            cancel + child-process tracking
    constants.js       ratios, reframe modes, defaults
    services/
      ffmpeg-util.js   spawn + progress parsing
      hwaccel.js       NVENC/QSV/AMF detection
      probe.js         metadata
      scenes.js        scene + keyframe detection
      segmenter.js     full-coverage segmentation
      thumbnails.js    per-scene preview frames
      cutter.js        clip cutting + reframe (blur pad / crop / smart)
      openrouter.js    AI layer (vision + text)
      transcribe.js    Whisper transcription (optional)
      exporter.js      batch export/copy
  renderer/
    index.html         UI structure
    styles.css         design system
    renderer.js        UI logic
```

## Notes

- Your OpenRouter API key is stored **encrypted at rest** (Windows DPAPI via Electron `safeStorage`)
  and is only ever used from the main process — it never reaches the renderer.
- Working files (thumbnails, cut clips) live under your user-data folder until you export them.

## License

MIT
