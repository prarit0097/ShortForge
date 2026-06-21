'use strict';

/**
 * Registers all IPC handlers and orchestrates the pipeline:
 *   analyze (probe -> scenes -> segment -> thumbs)
 *   enrich  (transcribe -> AI vision per clip)
 *   process (cut clips with reframe)
 *   export  (batch copy to chosen folder)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, shell, app } = require('electron');

const settingsStore = require('./settings');
const jobs = require('./jobs');
const hwaccel = require('./services/hwaccel');
const { probe } = require('./services/probe');
const { detectScenes, detectKeyframes } = require('./services/scenes');
const { buildSegments } = require('./services/segmenter');
const { extractThumbs, thumbAsDataUri } = require('./services/thumbnails');
const cutter = require('./services/cutter');
const exporter = require('./services/exporter');
const openrouter = require('./services/openrouter');
const transcribe = require('./services/transcribe');
const { STAGES } = require('./constants');

let getWin = () => null;

function emit(data) {
  const win = getWin();
  if (win && !win.isDestroyed()) win.webContents.send('job:progress', data);
}

function progress(jobId, stage, percent, message, extra = {}) {
  emit({ jobId, stage, percent: Math.round(percent), message, ...extra });
}

function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

/** Word-wrap a hook title to ~maxChars per line (drawtext has no auto-wrap). */
function wrapText(text, maxChars) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) {
      lines.push(line.trim());
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
    if (lines.length >= 3) break; // cap at 3 lines
  }
  if (line && lines.length < 3) lines.push(line.trim());
  return lines.join('\n');
}

function workDirFor(filePath) {
  const base = sanitizeName(path.basename(filePath, path.extname(filePath)));
  // Hash the full (normalized, lowercased) path so two different videos that share a
  // basename never collide — otherwise one job's transcript/thumbs leak into another.
  const hash = crypto.createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 8);
  return path.join(app.getPath('userData'), 'work', `${base}_${hash}`);
}

/** Bounded-concurrency map over items. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
}

function registerIpc(winGetter) {
  getWin = winGetter;
  settingsStore.migrate(); // one-time: old blur default → full-screen fill

  // ---- Pickers ---------------------------------------------------------------
  ipcMain.handle('dialog:pickVideos', async () => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: 'Select video(s) or movie(s)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'flv', 'wmv', 'ts', 'mpg', 'mpeg'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (res.canceled) return [];
    const out = [];
    for (const fp of res.filePaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        out.push(await probe(fp));
      } catch (err) {
        out.push({ path: fp, name: path.basename(fp), error: err.message });
      }
    }
    return out;
  });

  ipcMain.handle('probe:file', async (_e, filePath) => {
    try {
      return await probe(filePath);
    } catch (err) {
      return { path: filePath, name: path.basename(filePath), error: err.message };
    }
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: 'Choose download / export folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // ---- Settings / AI config --------------------------------------------------
  ipcMain.handle('settings:get', async () => {
    const { _fsMigration, ...settings } = settingsStore.load(); // hide internal sentinel
    return {
      ...settings,
      hasApiKey: settingsStore.hasApiKey(),
      whisperAvailable: transcribe.isAvailable(),
    };
  });

  ipcMain.handle('settings:set', async (_e, partial) => settingsStore.save(partial || {}));

  ipcMain.handle('settings:setApiKey', async (_e, key) => ({ ok: settingsStore.setApiKey(key) }));

  ipcMain.handle('ai:testKey', async () => {
    const s = settingsStore.load();
    const key = settingsStore.getApiKey();
    return openrouter.testKey(key, s.aiModelText);
  });

  ipcMain.handle('ai:listModels', async () => {
    const key = settingsStore.getApiKey();
    return openrouter.listModels(key);
  });

  // ---- Hardware --------------------------------------------------------------
  ipcMain.handle('hw:detect', async () => hwaccel.detect());

  // ---- Analyze ---------------------------------------------------------------
  ipcMain.handle('analyze:run', async (_e, { filePath, settings, jobId }) => {
    jobs.create(jobId);
    try {
      const meta = await probe(filePath);
      progress(jobId, STAGES.PROBE, 100, `Duration ${meta.duration.toFixed(1)}s`);

      // Scene detection (accurate) or fast keyframe fallback.
      let sceneTimes;
      if (settings.scanMode === 'fast') {
        progress(jobId, STAGES.SCENES, 5, 'Fast keyframe scan...');
        sceneTimes = await detectKeyframes(filePath, { jobId });
        progress(jobId, STAGES.SCENES, 100, `${sceneTimes.length} keyframes`);
      } else {
        sceneTimes = await detectScenes(filePath, {
          threshold: settings.sceneThreshold,
          jobId,
          totalDurationSec: meta.duration,
          onProgress: (p) => progress(jobId, STAGES.SCENES, p, 'Detecting scenes...'),
        });
        progress(jobId, STAGES.SCENES, 100, `${sceneTimes.length} scene changes`);
      }
      if (jobs.isCancelled(jobId)) { jobs.done(jobId); return { cancelled: true }; }

      // Full-coverage segmentation.
      const segments = buildSegments(sceneTimes, meta.duration, settings);
      progress(jobId, STAGES.SEGMENT, 100, `${segments.length} shorts planned`);

      // Thumbnails for the UI.
      const thumbDir = path.join(workDirFor(filePath), 'thumbs');
      const withThumbs = await extractThumbs(filePath, segments, thumbDir, {
        jobId,
        scale: 360,
        onProgress: (p) => progress(jobId, STAGES.THUMBS, p, 'Building previews...'),
      });

      jobs.done(jobId);
      return {
        meta,
        sceneCount: sceneTimes.length,
        segments: withThumbs.map((s) => ({ ...s, selected: true })),
        shortsCount: withThumbs.length,
      };
    } catch (err) {
      jobs.done(jobId);
      if (err && err.isCancelled) return { cancelled: true };
      throw err;
    }
  });

  // ---- AI enrich -------------------------------------------------------------
  ipcMain.handle('ai:enrich', async (_e, { filePath, segments, settings, jobId }) => {
    jobs.create(jobId);
    const key = settingsStore.getApiKey();
    if (!key) { jobs.done(jobId); throw new Error('Set your OpenRouter API key in Settings first.'); }

    const models = { vision: settings.aiModelVision, text: settings.aiModelText };
    try {
      // Optional transcription (captions + better titles).
      let transcriptSegs = [];
      if (settings.useTranscript !== false && transcribe.isAvailable()) {
        progress(jobId, STAGES.TRANSCRIBE, 5, 'Transcribing audio (Whisper)...');
        const tr = await transcribe.transcribe(filePath, { model: settings.whisperModel, jobId });
        transcriptSegs = tr.segments || [];
        progress(jobId, STAGES.TRANSCRIBE, 100,
          transcriptSegs.length ? `${transcriptSegs.length} transcript lines` : 'No speech detected');
      }
      if (jobs.isCancelled(jobId)) return { cancelled: true };

      let done = 0;
      const enriched = await pool(segments, 3, async (seg) => {
        if (jobs.isCancelled(jobId)) return seg;
        let dataUri = null;
        try { if (seg.thumbPath) dataUri = thumbAsDataUri(seg.thumbPath); } catch (_) { /* ignore */ }
        const tText = transcribe.textForRange(transcriptSegs, seg.start, seg.end);
        let ai = {};
        try {
          ai = await openrouter.enrichSegment(key, models, seg, dataUri, tText);
        } catch (err) {
          ai = { aiError: err.message, title: seg.title || `Short ${seg.index + 1}` };
        }
        done += 1;
        progress(jobId, STAGES.AI, (done / segments.length) * 100, `AI analysed ${done}/${segments.length}`);
        return { ...seg, ...ai, transcript: tText };
      });

      // If the user cancelled during the pool, don't return partial enrichment.
      if (jobs.isCancelled(jobId)) return { cancelled: true };

      // Persist transcript on disk so process() can reuse it for caption burn-in.
      try {
        const tf = path.join(workDirFor(filePath), 'transcript.json');
        fs.mkdirSync(path.dirname(tf), { recursive: true });
        fs.writeFileSync(tf, JSON.stringify(transcriptSegs), 'utf8');
      } catch (_) { /* ignore */ }

      return { segments: enriched, hasTranscript: transcriptSegs.length > 0 };
    } finally {
      jobs.done(jobId);
    }
  });

  // ---- Process (cut) ---------------------------------------------------------
  ipcMain.handle('process:run', async (_e, { filePath, segments, settings, jobId }) => {
    jobs.create(jobId);
    try {
      const meta = await probe(filePath);
      const workDir = workDirFor(filePath);
      const clipsDir = path.join(workDir, 'clips');
      fs.mkdirSync(clipsDir, { recursive: true });

      // Load transcript for caption burn-in if requested.
      let transcriptSegs = [];
      if (settings.burnCaptions) {
        try {
          transcriptSegs = JSON.parse(fs.readFileSync(path.join(workDir, 'transcript.json'), 'utf8'));
        } catch (_) { transcriptSegs = []; }
      }
      const captionsSkipped = !!settings.burnCaptions && transcriptSegs.length === 0;

      const burnTitle = settings.aiEnabled && settings.burnTitle !== false;

      // Attach per-clip caption + title files. Title is what makes an AI render visibly
      // different; we skip generic placeholder titles so non-AI clips aren't tagged.
      const prepared = segments.map((seg) => {
        const extra = {};
        if (settings.burnCaptions && transcriptSegs.length) {
          const srtPath = path.join(clipsDir, `seg_${seg.index}.srt`);
          extra.subtitlePath = transcribe.writeClipSrt(transcriptSegs, seg.start, seg.end, srtPath);
        }
        const isRealTitle = seg.title && !/^short\s*\d+$/i.test(seg.title.trim());
        if (burnTitle && isRealTitle) {
          const tf = path.join(clipsDir, `title_${seg.index}.txt`);
          fs.writeFileSync(tf, wrapText(seg.title, 20), 'utf8');
          extra.titleFile = tf;
        }
        return { ...seg, ...extra };
      });

      const clips = await cutter.cutAll(filePath, prepared, clipsDir, {
        jobId,
        ratioKey: settings.aspectRatio,
        reframeMode: settings.reframeMode,
        hwAccel: settings.hwAccel,
        quality: settings.outputQuality,
        enhance: !!settings.enhance,
        hasAudio: meta.hasAudio,
        srcW: meta.width,
        srcH: meta.height,
        concurrency: settings.cutConcurrency || 2,
        onProgress: (overall, completed, total) =>
          progress(jobId, STAGES.CUT, overall, `Cutting shorts… ${completed}/${total} done`),
      });

      if (jobs.isCancelled(jobId)) return { cancelled: true };
      return { clips, workDir: clipsDir, captionsSkipped };
    } catch (err) {
      if (err && err.isCancelled) return { cancelled: true };
      throw err;
    } finally {
      jobs.done(jobId);
    }
  });

  // ---- Export ----------------------------------------------------------------
  ipcMain.handle('export:batch', async (_e, { clips, destDir, settings, jobId }) => {
    jobs.create(jobId);
    try {
      const results = await exporter.exportClips(clips, destDir, {
        concurrency: (settings && settings.exportConcurrency) || 2,
        onProgress: (p, n, total) => progress(jobId, STAGES.EXPORT, p, `Exported ${n}/${total}`),
      });
      return { results, destDir };
    } finally {
      jobs.done(jobId);
    }
  });

  // ---- Job control + shell ---------------------------------------------------
  ipcMain.handle('job:cancel', async (_e, jobId) => jobs.cancel(jobId));

  ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:openExternal', async (_e, url) => { shell.openExternal(url); return true; });
  ipcMain.handle('shell:showItem', async (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('util:fileUrl', async (_e, p) => {
    const u = new URL('file://');
    u.pathname = path.resolve(p).replace(/\\/g, '/');
    return u.href;
  });
}

module.exports = { registerIpc };
