'use strict';

/**
 * Optional bundled Whisper transcription. nodejs-whisper is an optional dependency
 * (it builds whisper.cpp); everything is wrapped so the core app still works if it
 * is unavailable. Produces timestamped segments used for captions + better AI titles.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runFfmpeg } = require('./ffmpeg-util');

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

/** The npm module can load while the compiled whisper.cpp binary is absent — check both. */
function whisperBinaryExists() {
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
    return rel.some((r) => fs.existsSync(path.join(pkgDir, r)));
  } catch (_) {
    return false;
  }
}

function isAvailable() {
  return !!loadWhisper() && whisperBinaryExists();
}

/** Extract 16kHz mono WAV (what whisper.cpp expects). */
async function extractAudio(filePath, jobId) {
  const wav = path.join(os.tmpdir(), `sf_${Date.now()}.wav`);
  await runFfmpeg(
    ['-hide_banner', '-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
    { jobId }
  );
  return wav;
}

/**
 * Transcribe the whole file. Returns [{ start, end, text }] in seconds, or [] if
 * whisper is unavailable. Errors are swallowed into an empty transcript so the
 * pipeline degrades gracefully.
 */
async function transcribe(filePath, { model = 'base', jobId } = {}) {
  const mod = loadWhisper();
  if (!mod) return { available: false, segments: [] };

  let wav;
  try {
    wav = await extractAudio(filePath, jobId);
    const nodewhisper = mod.nodewhisper || mod.default || mod;
    const raw = await nodewhisper(wav, {
      modelName: model,
      autoDownloadModelName: model,
      whisperOptions: { outputInText: false, outputInSrt: true, wordTimestamps: false },
    });
    const segments = parseWhisperOutput(raw, wav);
    return { available: true, segments };
  } catch (err) {
    console.warn('[transcribe] failed:', err.message);
    return { available: true, segments: [], error: err.message };
  } finally {
    if (wav && fs.existsSync(wav)) {
      try { fs.unlinkSync(wav); } catch (_) { /* ignore */ }
    }
  }
}

function toSeconds(ts) {
  // "00:00:12,340" -> 12.34
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

/** Parse an SRT string (or sidecar .srt) into segments. */
function parseWhisperOutput(raw, wavPath) {
  let srt = typeof raw === 'string' ? raw : '';
  const sidecar = `${wavPath}.srt`;
  if ((!srt || !srt.includes('-->')) && fs.existsSync(sidecar)) {
    srt = fs.readFileSync(sidecar, 'utf8');
    try { fs.unlinkSync(sidecar); } catch (_) { /* ignore */ }
  }
  if (!srt.includes('-->')) return [];

  const segs = [];
  const blocks = srt.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const tline = lines.find((l) => l.includes('-->'));
    if (!tline) continue;
    const [a, b] = tline.split('-->').map((s) => s.trim());
    const text = lines.slice(lines.indexOf(tline) + 1).join(' ').trim();
    if (text) segs.push({ start: toSeconds(a), end: toSeconds(b), text });
  }
  return segs;
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
      const b = Math.max(a + 0.1, s.end - start);
      return `${i + 1}\n${fmt(a)} --> ${fmt(b)}\n${s.text}\n`;
    })
    .join('\n');
  fs.writeFileSync(outPath, body, 'utf8');
  return outPath;
}

module.exports = { isAvailable, transcribe, textForRange, writeClipSrt };
