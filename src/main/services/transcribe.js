'use strict';

/**
 * Optional bundled Whisper transcription. nodejs-whisper is an optional dependency
 * (it builds whisper.cpp); everything is wrapped so the core app still works if it
 * is unavailable. Produces timestamped segments used for captions + better AI titles.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('node:crypto');
const { runFfmpeg } = require('./ffmpeg-util');
const jobs = require('../jobs');

let whisperMod = null;
function loadWhisper() {
  if (whisperMod !== null) return whisperMod;
  try {
    // Lazy require so a failed build never crashes the app at startup.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    whisperMod = require('nodejs-whisper');
  } catch (err) {
    console.warn('[transcribe] nodejs-whisper unavailable:', err.message);
    whisperMod = false;
  }
  return whisperMod;
}

/** The JavaScript wrapper can load before a CLI or native backend is installed. */
function whisperBackendExists() {
  try {
    const pkgDir = path.dirname(require.resolve('nodejs-whisper/package.json'));
    const rel = [
      'cpp/whisper.cpp/build/bin/Release/whisper-cli.exe',
      'cpp/whisper.cpp/build/bin/Release/main.exe',
      'cpp/whisper.cpp/build/bin/whisper-cli.exe',
      'cpp/whisper.cpp/build/bin/whisper-cli',
      'cpp/whisper.cpp/main.exe',
      'cpp/whisper.cpp/main',
    ];
    for (const variant of ['default', 'cuda']) {
      rel.push(`build/${variant}/Release/nodejs_whisper.node`,
        `prebuilds/${process.platform}-${process.arch}/${variant}/nodejs_whisper.node`);
    }
    return rel.some((r) => fs.existsSync(path.join(pkgDir, r)));
  } catch (_) {
    return false;
  }
}

function isAvailable() {
  return !!loadWhisper()?.nodewhisper && whisperBackendExists();
}

/** Extract 16kHz mono WAV (what whisper.cpp expects). */
function extractAudio(filePath, wav, { jobId, audioTrack, trackCount, inputArgs }) {
  const mixed = audioTrack === 'mix' && trackCount > 1;
  const inputs = mixed ? Array.from({ length: trackCount }, (_, index) => `[0:a:${index}]`).join('') : '';
  const mapping = mixed
    ? ['-filter_complex', `${inputs}amix=inputs=${trackCount}:duration=longest[audio]`, '-map', '[audio]']
    : ['-map', `0:a:${Number.isSafeInteger(audioTrack) ? audioTrack : 0}`];
  return runFfmpeg(['-hide_banner', '-nostdin', '-y', ...inputArgs, '-i', filePath, ...mapping,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { jobId });
}

/**
 * Transcribe the whole file. Returns [{ start, end, text }] in seconds, or [] if
 * whisper is unavailable. Errors are swallowed into an empty transcript so the
 * pipeline degrades gracefully.
 */
async function transcribe(filePath, { model = 'base', jobId, audioTrack = 0, trackCount = 1, modelRootPath, inputArgs = [] } = {}) {
  if (audioTrack === 'none' || !trackCount) return { available: true, segments: [] };
  const mod = loadWhisper();
  if (!mod?.nodewhisper) return { available: false, segments: [] };

  const wav = path.join(os.tmpdir(), `sf_${randomUUID()}.wav`);
  try {
    await extractAudio(filePath, wav, { jobId, audioTrack, trackCount, inputArgs });
    if (modelRootPath) fs.mkdirSync(modelRootPath, { recursive: true });
    const result = await mod.nodewhisper(wav, {
      modelName: model,
      autoDownloadModelName: model,
      modelRootPath,
      whisperOptions: { outputInSrt: false, outputInText: false },
    });
    if (jobId && jobs.isCancelled(jobId)) throw new jobs.CancelledError();
    const segments = [...result.matchAll(/^\s*\[([^\]\r\n]+) --> ([^\]\r\n]+)\][ \t]*(.+)$/gm)]
      .map(([, start, end, text]) => ({ start: toSeconds(start), end: toSeconds(end), text: text.trim() }))
      .filter(({ start, end, text }) => Number.isFinite(start) && end > start && text);
    return { available: true, segments };
  } catch (err) {
    if (jobId && jobs.isCancelled(jobId)) throw new jobs.CancelledError();
    console.warn('[transcribe] failed:', err.message);
    return { available: true, segments: [], error: err.message };
  } finally {
    for (const file of [wav, `${wav}.srt`]) {
      try { fs.rmSync(file, { force: true }); } catch (_) { /* ignore */ }
    }
  }
}

function toSeconds(timestamp) {
  const [hours, minutes, seconds] = timestamp.replace(',', '.').split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
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

module.exports = { isAvailable, transcribe, textForRange, writeClipSrt };
