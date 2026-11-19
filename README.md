# ShortForge 🎬→📲

A lightweight **Windows desktop app** that turns long videos and movies (1 GB–10 GB) into
short clips **scene-by-scene with full coverage** — nothing gets skipped. Optional **AI layer**
(OpenRouter) adds scene descriptions, virality scores, titles, captions, hashtags, and a
per-clip crop hint. Video processing is local. Optional OpenRouter enrichment asks before
sending still frames. Sharing transcript excerpts is off by default.


## Maintainer and project overview

Built by [Prarit Sidana](https://praritsidana.com/). See the [ShortForge project overview](https://praritsidana.com/projects/shortforge) for its place in the portfolio.

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
- **Gameplay editor** — mark a moment in an OBS, capture-card, or console recording, preview it
  with sound, adjust the in/out points, and render or rerender one clip. Use HUD-safe 9:16 to
  retain the whole game frame or keep the original framing for a horizontal export.
- **Audio and projects** — choose a track, mix tracks, or mute. Save the clip plan and resume
  editing later with the same recording and available renders.
- **Local highlight suggestions** — find gameplay moments from changes in motion and sound,
  then review the ranked clips. **Watch recordings** lists new OBS or replay-buffer files once
  they stop changing and lets you choose which one to import.
- **Import from a link** — paste a public YouTube video or direct video URL to start the local
  gameplay scan. Turn on **Auto-render HUD-safe 9:16** before pasting to render the suggestions.

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
> then add your OpenRouter key in **App settings**.

## Build a Windows installer

```bash
npm run dist
```

Produces an NSIS installer in `dist/`. (Add `build/icon.ico` for a custom icon.)

## How cutting works (so no scene is missed)

1. **Scene detection** — FFmpeg scene filter finds every scene-change timestamp (tunable sensitivity).
   For very large files, a fast keyframe-only scan is available.
2. **Full-coverage segmentation** — starting at 0, each segment extends toward your *target* length and
   snaps to the nearest scene boundary that leaves enough time for the remaining clips. With no
   qualifying boundary, it cuts at the latest time that still fits. If both length bounds are
   impossible, it favors the maximum and shares the remaining time evenly. The plan covers the
   entire video from `0 → end` with no gaps or overlaps.
3. **Cutting** — each segment is re-encoded with frame-accurate seeking (so cuts are exact), reframed
   to your chosen ratio, optionally captioned, using hardware acceleration when available.

## Whisper (captions / transcript)

Captions and transcript-aware titles use a **bundled local Whisper** (`nodejs-whisper`, an optional
dependency). If it isn't installed/built on your machine, the core app still works fully — only the
audio-transcript features are skipped. Models are selectable in Settings. The default `base`
supports multiple languages.

When you render selected clips with captions enabled, Whisper reads only those clip ranges on the
selected audio track or mix. The progress dialog shows transcription progress and lets you stop
Whisper mid-job.

## Local CLI and MCP

The optional automation interface uses two existing, user-controlled folders for input and output. Run `npm install` first, then set the roots in PowerShell.

```powershell
$env:SHORTFORGE_INPUT_ROOT = 'D:\OBS\Recordings'
$env:SHORTFORGE_OUTPUT_ROOT = 'D:\Shorts'
node src/automation/cli.js analyze 'session.mkv' --mode gameplay
```

To render a clip, copy its ID from the analysis result and give `render` the same source and analysis flags. Add `--aspect-ratio 9:16 --reframe-mode blur` for HUD-safe vertical video.

The local stdio MCP server exposes `analyze_video`, `get_job`, `render_clips`, and `cancel_job`. See the [automation setup](videocut.md#local-cli-and-mcp-setup) for Codex registration and examples.

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
- Failed renders can be retried from the results list. Successful renders are available for export.
- Run `npm test` for the regression tests.

## License

MIT
