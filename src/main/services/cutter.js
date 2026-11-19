'use strict';

/**
 * Cuts each segment into an output clip. Builds a single filter_complex pipeline:
 *   reframe (blur pad / center crop / smart crop)  ->  AI hook title (drawtext)
 *   ->  burned captions (subtitles).
 * The title + captions are what make an AI-enabled render visibly different from a
 * plain one. Uses hardware encoding when available; re-encodes for frame-accurate cuts.
 */

const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./ffmpeg-util');
const { encoderArgs } = require('./hwaccel');
const { ASPECT_RATIOS } = require('../constants');
const jobs = require('../jobs');

function sanitize(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80) || 'clip';
}

/** Escape a Windows path for use inside an ffmpeg filter option value. */
function escFilterPath(p) {
  return p
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\''"); // an apostrophe in the path must not terminate the quoted value
}

// Resolve a bold system font for the hook title once, robust to non-C: Windows
// installs and SKUs missing Arial. null → title burn is skipped (clip still renders).
const TITLE_FONT = (() => {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = ['ARIALBD.TTF', 'arialbd.ttf', 'segoeuib.ttf', 'seguisb.ttf', 'ARIAL.TTF', 'arial.ttf', 'segoeui.ttf'];
  for (const f of candidates) {
    try {
      const p = path.join(root, 'Fonts', f);
      if (fs.existsSync(p)) return escFilterPath(p);
    } catch (_) { /* ignore */ }
  }
  return null;
})();

/**
 * Build the full filter_complex. Returns { filter, map } or null when no filtering
 * is needed (original ratio, no title, no captions → can encode straight).
 * @param o { ratioKey, reframeMode, cropBias, titleFile, subtitlePath, srcW, srcH }
 */
function buildFilterComplex(o) {
  const r = ASPECT_RATIOS[o.ratioKey];
  const reframe = r && o.ratioKey !== 'original' && r.w > 0;
  const outW = reframe ? r.w : (o.srcW || 1080);
  const outH = reframe ? r.h : (o.srcH || 1920);

  const parts = [];
  let inLabel = `[${o.videoMap || '0:V:0'}]`;
  let idx = 0;
  const next = () => `[v${idx++}]`;

  if (reframe) {
    const factor = o.preview ? 720 / Math.max(r.w, r.h) : 1;
    const w = Math.round(r.w * factor / 2) * 2;
    const h = Math.round(r.h * factor / 2) * 2;
    const out = next();
    if (o.reframeMode === 'crop' || o.reframeMode === 'smart') {
      const bias = Math.max(-1, Math.min(1, o.cropBias || 0));
      const x = `(in_w-out_w)/2+${(bias * 0.5).toFixed(3)}*(in_w-out_w)`;
      parts.push(`${inLabel}scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}:${x}:(in_h-out_h)/2${out}`);
    } else {
      // Blur pad — blur a downscaled copy then upscale (≈5x faster than full-size blur).
      const sw = Math.max(2, Math.round(w / 4 / 2) * 2);
      const sh = Math.max(2, Math.round(h / 4 / 2) * 2);
      parts.push(
        `${inLabel}split=2[bg][fg];` +
        `[bg]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=12:2,scale=${w}:${h}[bgb];` +
        `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2${out}`
      );
    }
    inLabel = out;
  } else if (o.preview) {
    const out = next();
    parts.push(`${inLabel}scale=720:720:force_original_aspect_ratio=decrease:force_divisible_by=2${out}`);
    inLabel = out;
  }

  // Optional enhance: light denoise + sharpen + subtle pop (perceived quality boost).
  if (o.enhance) {
    const out = next();
    parts.push(`${inLabel}hqdn3d=2:1.5:4:4,unsharp=5:5:0.7:5:5:0.0,eq=saturation=1.06:contrast=1.03${out}`);
    inLabel = out;
  }

  if (o.titleFile && TITLE_FONT) {
    const out = next();
    const fontSize = Math.max(22, Math.round(Math.min(outW, outH) / 20));
    parts.push(
      `${inLabel}drawtext=fontfile='${TITLE_FONT}':textfile='${escFilterPath(o.titleFile)}':` +
      `fontcolor=white:fontsize=${fontSize}:line_spacing=8:box=1:boxcolor=black@0.5:boxborderw=18:` +
      `x=(w-text_w)/2:y=h*0.06${out}`
    );
    inLabel = out;
  }

  if (o.subtitlePath) {
    const out = next();
    const subFont = Math.max(14, Math.round(Math.min(outW, outH) / 45));
    parts.push(
      `${inLabel}subtitles='${escFilterPath(o.subtitlePath)}':` +
      `force_style='Fontsize=${subFont},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=70'${out}`
    );
    inLabel = out;
  }

  if (!parts.length) return null;
  return { filter: parts.join(';'), map: inLabel };
}

/** Cut a single segment to outPath. */
async function cutClip(filePath, seg, outPath, options) {
  const { hwAccel, hasAudio, audioTrack = 0, inputArgs = [] } = options;
  const { vargs, audioBitrate } = await encoderArgs(hwAccel, options.quality);
  if (options.jobId && jobs.isCancelled(options.jobId)) throw new jobs.CancelledError();

  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-abort_on', 'empty_output'];
  // Fast + accurate: input seeking before -i, re-encode trims precisely from prior keyframe.
  args.push('-ss', String(seg.start), '-to', String(seg.end), ...inputArgs, '-i', filePath);
  const videoMap = Number.isInteger(options.videoStreamIndex) ? `0:${options.videoStreamIndex}` : '0:V:0';
  const trackCount = options.audioTracks?.length ?? (hasAudio ? 1 : 0);
  const includeAudio = trackCount > 0 && audioTrack !== 'none';
  const mixAudio = includeAudio && audioTrack === 'mix' && trackCount > 1;
  const ordinal = Number.isInteger(audioTrack) ? audioTrack : 0;
  if (includeAudio && !mixAudio && (ordinal < 0 || ordinal >= trackCount)) {
    throw new Error('The selected audio track is unavailable.');
  }

  const fc = buildFilterComplex({
    ratioKey: options.ratioKey,
    reframeMode: options.reframeMode,
    cropBias: seg.cropBias || 0,
    enhance: options.enhance,
    titleFile: seg.titleFile || null,
    subtitlePath: seg.subtitlePath || options.subtitlePath || null,
    srcW: options.srcW,
    srcH: options.srcH,
    preview: options.preview,
    videoMap,
  });

  const mixFilter = mixAudio && Array.from({ length: trackCount }, (_, index) => `[0:a:${index}]`).join('') +
    `amix=inputs=${trackCount}:duration=longest:dropout_transition=0[clipaudio]`;
  const filters = [fc?.filter, mixFilter].filter(Boolean).join(';');
  if (filters) args.push('-filter_complex', filters);
  args.push('-map', fc?.map || videoMap);
  if (includeAudio) args.push('-map', mixAudio ? '[clipaudio]' : `0:a:${ordinal}`);

  args.push(...vargs);
  if (includeAudio) args.push('-c:a', 'aac', '-b:a', audioBitrate);
  else args.push('-an');
  args.push('-movflags', '+faststart', outPath);

  const { stdout } = await runFfmpeg(args, {
    jobId: options.jobId,
    totalDurationSec: seg.duration,
    onProgress: options.onClipProgress,
  });
  const lastFrameReport = stdout.match(/^frame=[ \t]*\d+[ \t\r]*$/gm)?.pop();
  if (Number(lastFrameReport?.slice('frame='.length) || 0) <= 0) {
    throw new Error('FFmpeg wrote no video frames in this clip.');
  }
  return outPath;
}

/**
 * Cut all selected segments with bounded concurrency. Aggregates per-clip progress
 * into an overall percentage so the bar always moves, and honours cancellation.
 */
async function cutAll(filePath, segments, workDir, options) {
  const total = segments.length;
  const results = segments.map(({ index }) => ({ index, status: 'cancelled' }));
  const isCancelled = () => options.jobId && jobs.isCancelled(options.jobId);
  if (!total || isCancelled()) return results;

  // Each attempt owns a fresh directory so a retry cannot overwrite a prior render.
  await fs.promises.mkdir(workDir, { recursive: true });
  const batchDir = await fs.promises.mkdtemp(path.join(workDir, 'render-'));
  const frac = new Array(total).fill(0);
  let completed = 0;
  const concurrency = Math.max(1, Math.min(options.concurrency || 2, total));

  function report() {
    if (!options.onProgress) return;
    const sum = frac.reduce((a, b) => a + b, 0);
    options.onProgress((sum / total) * 100, completed, total);
  }

  let next = 0;
  async function worker() {
    while (next < total && !isCancelled()) {
      const i = next++;
      const seg = segments[i];
      const base = sanitize(seg.title || `short_${String(seg.index + 1).padStart(3, '0')}`);
      const fileName = `${String(seg.index + 1).padStart(3, '0')}_${base}.mp4`;
      const outPath = path.join(batchDir, fileName);
      const tempPath = path.join(batchDir, `.${i}.part.mp4`);
      try {
        await cutClip(filePath, seg, tempPath, {
          ...options,
          onClipProgress: (clipPct) => { frac[i] = Math.min(1, clipPct / 100); report(); },
        });
        if (isCancelled()) return;
        await fs.promises.rename(tempPath, outPath);
        results[i] = { index: seg.index, status: 'ready', outputPath: outPath, fileName };
      } catch (err) {
        if (err.isCancelled || isCancelled()) return;
        results[i] = { index: seg.index, status: 'failed', error: err.message };
      } finally {
        if (results[i].status !== 'ready') {
          await fs.promises.rm(tempPath, { force: true }).catch(() => {});
        }
      }
      frac[i] = 1;
      completed += 1;
      report();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  if (!results.some((result) => result.status === 'ready')) {
    await fs.promises.rmdir(batchDir).catch(() => {});
  }
  return results;
}

module.exports = { cutAll, cutClip, buildFilterComplex };
