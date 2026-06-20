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

// Bold system font for the hook title (present on all Windows installs).
const TITLE_FONT = 'C\\:/Windows/Fonts/ARIALBD.TTF';

function sanitize(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80) || 'clip';
}

/** Escape a Windows path for use inside an ffmpeg filter option value. */
function escFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

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
  let inLabel = '[0:v]';
  let idx = 0;
  const next = () => `[v${idx++}]`;

  if (reframe) {
    const { w, h } = r;
    const out = next();
    if (o.reframeMode === 'crop' || o.reframeMode === 'smart') {
      const bias = Math.max(-1, Math.min(1, o.cropBias || 0));
      const x = `(in_w-out_w)/2+${(bias * 0.5).toFixed(3)}*(in_w-out_w)`;
      parts.push(`${inLabel}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:${x}:(in_h-out_h)/2${out}`);
    } else {
      // Blur pad — blur a downscaled copy then upscale (≈5x faster than full-size blur).
      const sw = Math.max(2, Math.round(w / 4 / 2) * 2);
      const sh = Math.max(2, Math.round(h / 4 / 2) * 2);
      parts.push(
        `${inLabel}split=2[bg][fg];` +
        `[bg]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=12:2,scale=${w}:${h}[bgb];` +
        `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2${out}`
      );
    }
    inLabel = out;
  }

  if (o.titleFile) {
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
  const { hwAccel, hasAudio } = options;
  const encArgs = await encoderArgs(hwAccel);

  const args = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats'];
  // Fast + accurate: input seeking before -i, re-encode trims precisely from prior keyframe.
  args.push('-ss', String(seg.start), '-to', String(seg.end), '-i', filePath);

  const fc = buildFilterComplex({
    ratioKey: options.ratioKey,
    reframeMode: options.reframeMode,
    cropBias: seg.cropBias || 0,
    titleFile: seg.titleFile || null,
    subtitlePath: seg.subtitlePath || options.subtitlePath || null,
    srcW: options.srcW,
    srcH: options.srcH,
  });

  if (fc) {
    args.push('-filter_complex', fc.filter, '-map', fc.map);
    if (hasAudio) args.push('-map', '0:a:0?');
  }

  args.push(...encArgs);
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-movflags', '+faststart', outPath);

  await runFfmpeg(args, {
    jobId: options.jobId,
    totalDurationSec: seg.duration,
    onProgress: options.onClipProgress,
  });
  return outPath;
}

/**
 * Cut all selected segments with bounded concurrency. Aggregates per-clip progress
 * into an overall percentage so the bar always moves, and honours cancellation.
 */
async function cutAll(filePath, segments, workDir, options) {
  fs.mkdirSync(workDir, { recursive: true });
  const total = segments.length;
  const results = new Array(total);
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
    while (next < total) {
      const i = next++;
      if (options.jobId && jobs.isCancelled(options.jobId)) return;
      const seg = segments[i];
      const base = sanitize(seg.title || `short_${String(seg.index + 1).padStart(3, '0')}`);
      const outPath = path.join(workDir, `${String(seg.index + 1).padStart(3, '0')}_${base}.mp4`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await cutClip(filePath, seg, outPath, {
          ...options,
          onClipProgress: (clipPct) => { frac[i] = Math.min(1, clipPct / 100); report(); },
        });
        frac[i] = 1;
        completed += 1;
        results[i] = { ...seg, outputPath: outPath, fileName: path.basename(outPath) };
        report();
      } catch (err) {
        if (String(err && err.message).includes('cancelled')) return;
        frac[i] = 1;
        completed += 1;
        results[i] = null;
        report();
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.filter(Boolean);
}

module.exports = { cutAll, cutClip, buildFilterComplex };
