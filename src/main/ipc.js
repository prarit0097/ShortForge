'use strict';

/**
 * Registers all IPC handlers and orchestrates the pipeline:
 *   analyze (probe -> scenes -> segment)
 *   enrich  (transcribe -> AI vision per clip)
 *   process (cut clips with reframe)
 *   export  (batch copy to chosen folder)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('node:url');
const { ipcMain, dialog, shell, app } = require('electron');

const settingsStore = require('./settings');
const jobs = require('./jobs');
const hwaccel = require('./services/hwaccel');
const { probe } = require('./services/probe');
const { extractThumbs, thumbAsDataUri } = require('./services/thumbnails');
const { analyzeVideo, renderVideo } = require('./services/pipeline');
const projects = require('./services/projects');
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

function checkedSegment(segment, duration) {
  const { index, start, end } = segment || {};
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || start >= end || start >= duration || end > duration + 0.01) throw new Error('Clip range is outside the recording.');
  return { ...segment, end: Math.min(end, duration), duration: Math.min(end, duration) - start };
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

  ipcMain.handle('projects:save', async (_e, draft) => {
    const result = await dialog.showSaveDialog(getWin(), {
      title: 'Save ShortForge project',
      defaultPath: `${path.basename(draft.sourcePath, path.extname(draft.sourcePath))}.shortforge`,
      filters: [{ name: 'ShortForge project', extensions: ['shortforge'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await projects.saveProject(result.filePath, draft, { cacheRoot: path.join(workDirFor(draft.sourcePath), 'clips') });
    return { filePath: result.filePath };
  });

  ipcMain.handle('projects:open', async () => {
    const result = await dialog.showOpenDialog(getWin(), {
      title: 'Open ShortForge project', properties: ['openFile'],
      filters: [{ name: 'ShortForge project', extensions: ['shortforge'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const project = await projects.openProject(result.filePaths[0], {
      cacheRootForSource: (source) => path.join(workDirFor(source), 'clips'),
    });
    const video = await probe(project.sourcePath);
    if (!video.width || !video.height || !video.duration) throw new Error('The project recording has no playable video.');
    const segments = project.segments.filter(({ start, end }) => start < video.duration && end <= video.duration + 0.01)
      .map((segment) => checkedSegment(segment, video.duration));
    return { ...project, video, segments };
  });

  // ---- Analyze ---------------------------------------------------------------
  ipcMain.handle('analyze:run', async (_e, { filePath, settings, jobId }) => {
    jobs.create(jobId);
    try {
      return await analyzeVideo({ filePath, settings, jobId, onProgress: (...event) => progress(jobId, ...event) });
    } catch (err) {
      if (err && err.isCancelled) return { cancelled: true };
      throw err;
    } finally {
      jobs.done(jobId);
    }
  });

  ipcMain.handle('video:thumbnails', async (_e, { filePath, segments, jobId }) => {
    if (!Array.isArray(segments) || segments.length > 24) throw new Error('Thumbnail requests support up to 24 clips.');
    jobs.create(jobId);
    try {
      const range = segments.map((segment) => checkedSegment(segment, Infinity));
      const result = await extractThumbs(filePath, range, path.join(workDirFor(filePath), 'thumbs'), { jobId });
      return { segments: result.map(({ index, thumbPath }) => ({ index, thumbPath })) };
    } catch (err) {
      if (err?.isCancelled) return { cancelled: true, segments: [] };
      throw err;
    } finally {
      jobs.done(jobId);
    }
  });

  ipcMain.handle('video:previewClip', async (_e, { filePath, segment, settings, jobId }) => {
    jobs.create(jobId);
    try {
      const meta = await probe(filePath, { jobId });
      const range = checkedSegment(segment, meta.duration);
      if (range.duration > 600) throw new Error('Preview up to 10 minutes at a time.');
      const { index, start, end, duration, cropBias } = range;
      const [result] = await renderVideo({
        filePath, segments: [{ index, start, end, duration, cropBias }], meta, jobId, preview: true,
        workDir: path.join(workDirFor(filePath), 'previews'),
        settings: { ...settings, enhance: false, hwAccel: 'cpu', outputQuality: 'balanced', cutConcurrency: 1 },
        onProgress: (percent) => progress(jobId, STAGES.CUT, percent, 'Preparing preview…'),
      });
      if (result?.status === 'cancelled') return { cancelled: true };
      if (result?.status !== 'ready') throw new Error(result?.error || 'Preview could not be created.');
      return { outputPath: result.outputPath };
    } catch (err) {
      if (err?.isCancelled) return { cancelled: true };
      throw err;
    } finally {
      jobs.done(jobId);
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
        try {
          const [thumb] = await extractThumbs(filePath, [checkedSegment(seg, Infinity)],
            path.join(workDirFor(filePath), 'thumbs'), { jobId });
          if (thumb?.thumbPath) dataUri = thumbAsDataUri(thumb.thumbPath);
        } catch (err) {
          if (err?.isCancelled) return seg;
        }
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
    let sidecarDir;
    try {
      const meta = await probe(filePath, { jobId });
      if (jobs.isCancelled(jobId)) return { cancelled: true };
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
      if (burnTitle || (settings.burnCaptions && transcriptSegs.length)) {
        sidecarDir = fs.mkdtempSync(path.join(clipsDir, 'prepare-'));
      }

      // Attach per-clip caption + title files. Title is what makes an AI render visibly
      // different; we skip generic placeholder titles so non-AI clips aren't tagged.
      const prepared = segments.map((segment) => {
        const seg = checkedSegment(segment, meta.duration);
        const extra = {};
        if (settings.burnCaptions && transcriptSegs.length) {
          const srtPath = path.join(sidecarDir, `seg_${seg.index}.srt`);
          extra.subtitlePath = transcribe.writeClipSrt(transcriptSegs, seg.start, seg.end, srtPath);
        }
        const isRealTitle = seg.title && !/^short\s*\d+$/i.test(seg.title.trim());
        if (burnTitle && isRealTitle) {
          const tf = path.join(sidecarDir, `title_${seg.index}.txt`);
          fs.writeFileSync(tf, wrapText(seg.title, 20), 'utf8');
          extra.titleFile = tf;
        }
        return { ...seg, ...extra };
      });

      const results = await renderVideo({
        filePath, segments: prepared, workDir: clipsDir, settings, meta, jobId,
        onProgress: (overall, completed, total) =>
          progress(jobId, STAGES.CUT, overall, `Cutting shorts… ${completed}/${total} done`),
      });

      return { results, workDir: clipsDir, captionsSkipped, cancelled: jobs.isCancelled(jobId) };
    } catch (err) {
      if (err && err.isCancelled) return { cancelled: true };
      throw err;
    } finally {
      if (sidecarDir) await fs.promises.rm(sidecarDir, { recursive: true, force: true }).catch(() => {});
      jobs.done(jobId);
    }
  });

  // ---- Export ----------------------------------------------------------------
  ipcMain.handle('export:batch', async (_e, { clips, destDir, settings, jobId }) => {
    jobs.create(jobId);
    try {
      const results = await exporter.exportClips(clips, destDir, {
        jobId,
        concurrency: (settings && settings.exportConcurrency) || 2,
        onProgress: (p, n, total) => progress(jobId, STAGES.EXPORT, p, `Exporting shorts… ${n}/${total} done`),
      });
      return { results, destDir, cancelled: jobs.isCancelled(jobId) };
    } finally {
      jobs.done(jobId);
    }
  });

  // ---- Job control + shell ---------------------------------------------------
  ipcMain.handle('job:cancel', async (_e, jobId) => jobs.cancel(jobId));

  ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:openExternal', async (_e, url) => { shell.openExternal(url); return true; });
  ipcMain.handle('shell:showItem', async (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('util:fileUrl', async (_e, p) => pathToFileURL(p).href);
}

module.exports = { registerIpc };
