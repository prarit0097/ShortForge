'use strict';

/**
 * Optional bundled Whisper transcription. nodejs-whisper is an optional dependency
 * (it builds whisper.cpp); everything is wrapped so the core app still works if it
 * is unavailable. Produces timestamped segments used for captions + better AI titles.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, execFile } = require('node:child_process');
const { runFfmpeg } = require('./ffmpeg-util');
const jobs = require('../jobs');

/** The optional wrapper can load even when neither backend is installed. */
function whisperBackend() {
  try {
    const { findNativeAddon } = require('nodejs-whisper/dist/native');
    const { getWhisperExecutablePath } = require('nodejs-whisper/dist/whisper');
    if (findNativeAddon()) return getWhisperExecutablePath() ? 'auto' : 'native';
    return getWhisperExecutablePath() ? 'cli' : null;
  } catch (_) {
    return null;
  }
}

function isAvailable() {
  return !!whisperBackend();
}

/** Merge overlaps, keeping separate windows for adjacent clips. */
function selectedAudioRanges(clips) {
  const ranges = clips.map(({ start, end }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end) {
      throw new Error('Invalid selected audio range.');
    }
    return { start, end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

function extractAudio({ filePath, audioTrack, trackCount, inputArgs, scratch }, { start, end }, jobId) {
  const mixed = audioTrack === 'mix' && trackCount > 1;
  const inputs = mixed ? Array.from({ length: trackCount }, (_, index) => `[0:a:${index}]`).join('') : '';
  const mapping = mixed
    ? ['-filter_complex', `${inputs}amix=inputs=${trackCount}:duration=longest[audio]`, '-map', '[audio]']
    : ['-map', `0:a:${Number.isSafeInteger(audioTrack) ? audioTrack : 0}`];
  return runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputArgs,
    '-ss', String(start), '-i', filePath, '-t', String(end - start), ...mapping,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(scratch, 'audio.wav')], { jobId });
}

function runWorker(request, jobId, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new jobs.CancelledError());
    const worker = fork(path.join(__dirname, 'transcribe-worker.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [], windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result;
    let failure;
    let extraction;
    const cancel = () => {
      if (!worker.pid) return;
      // Native Whisper uses threads in this process. A CLI fallback can spawn descendants.
      if (request.backend === 'native') {
        worker.kill('SIGKILL');
        return;
      }
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/pid', String(worker.pid), '/t', '/f'], { windowsHide: true },
          (error) => { if (error && worker.exitCode === null && worker.signalCode === null) worker.kill(); });
      } else {
        try { process.kill(-worker.pid, 'SIGKILL'); } catch (_) { /* already exited */ }
      }
    };

    signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', (message) => {
      if (signal?.aborted) return;
      if (message.progress) onProgress?.(message.progress);
      else if (message.extract) {
        extraction = extractAudio(request, message.extract, jobId).then(
          () => { if (worker.connected && !signal?.aborted) worker.send({}); },
          (error) => { if (worker.connected && !signal?.aborted) worker.send({ error: error.message }); },
        );
      }
      else result = message;
    });
    worker.on('error', (error) => { failure = error; });
    worker.once('close', async (code) => {
      signal?.removeEventListener('abort', cancel);
      await extraction;
      if (signal?.aborted) reject(new jobs.CancelledError());
      else if (failure || code !== 0 || !result) reject(failure || new Error(`Whisper worker exited (${code}).`));
      else resolve(result);
    });
    worker.send(request);
  });
}

/** Transcribe selected source-time ranges without blocking the editor. */
async function transcribe(filePath, {
  ranges, model = 'base', jobId, audioTrack = 0, trackCount = 1,
  modelRootPath = path.join(os.tmpdir(), 'ShortForge-whisper-models'), inputArgs = [], onProgress,
} = {}) {
  const selected = selectedAudioRanges(ranges);
  if (!selected.length || audioTrack === 'none' || !trackCount) return { available: true, segments: [] };
  const backend = whisperBackend();
  if (!backend) return { available: false, segments: [] };
  if (jobId && jobs.isCancelled(jobId)) throw new jobs.CancelledError();
  const signal = jobs.get(jobId)?.controller.signal;
  let scratch;
  try {
    fs.mkdirSync(modelRootPath, { recursive: true });
    scratch = fs.mkdtempSync(path.join(modelRootPath, '.transcribe-'));
    return await runWorker({ filePath, ranges: selected, model, audioTrack, trackCount,
      modelRootPath, inputArgs, scratch, backend }, jobId, signal, onProgress);
  } catch (err) {
    if (err.isCancelled) throw err;
    console.warn('[transcribe] failed:', err.message);
    return { available: true, segments: [], error: err.message };
  } finally {
    if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** Pick transcript text overlapping a [start,end] window. */
function textForRange(segments, start, end) {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text)
    .join(' ')
    .trim();
}

/** Write an SRT file (relative timestamps) for one clip, for caption burn-in. */
function writeClipSrt(segments, start, end, outPath) {
  const inRange = segments.filter((s) => s.end > start && s.start < end);
  if (!inRange.length) return null;
  const fmt = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const mm = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${mm}`;
  };
  const body = inRange
    .map((s, i) => {
      const a = Math.max(0, s.start - start);
      const b = Math.min(end - start, Math.max(a + 0.001, s.end - start));
      return `${i + 1}\n${fmt(a)} --> ${fmt(b)}\n${s.text}\n`;
    })
    .join('\n');
  fs.writeFileSync(outPath, body, 'utf8');
  return outPath;
}

module.exports = { isAvailable, selectedAudioRanges, transcribe, textForRange, writeClipSrt };
