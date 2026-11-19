'use strict';

/** Extracts a single representative frame per segment (UI previews + AI vision input). */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { runFfmpeg } = require('./ffmpeg-util');
const jobs = require('../jobs');

/**
 * Extract one JPEG near each segment start.
 * @param scale width in px (small for AI/cost, larger for crisp UI). -1 keeps aspect.
 * @returns segments enriched with { thumbPath }
 */
async function extractThumbs(filePath, segments, outDir, { jobId, scale = 360, onProgress, inputArgs = [] } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const source = fs.statSync(filePath);
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Grab a frame a hair after the start to avoid black transition frames.
    const at = Math.max(0, Number.isFinite(seg.peak) && seg.peak >= seg.start && seg.peak < seg.end
      ? seg.peak : seg.start + Math.min(0.5, seg.duration / 4));
    const name = `${source.size}_${source.mtimeMs}_${Math.round(at * 1000)}_${scale}`;
    const thumbPath = path.join(outDir, `${name}.jpg`);
    const temporary = path.join(outDir, `${randomUUID()}.jpg`);
    try {
      if (!fs.existsSync(thumbPath)) {
        await runFfmpeg([
          '-hide_banner', '-nostdin', '-y', '-ss', String(at), ...inputArgs, '-i', filePath,
          '-map', '0:V:0', '-frames:v', '1', '-vf', `scale=${scale}:-1`, '-q:v', '3', temporary,
        ], { jobId });
        if (fs.existsSync(temporary)) fs.renameSync(temporary, thumbPath);
      }
      out.push({ ...seg, thumbPath: fs.existsSync(thumbPath) ? thumbPath : null });
    } catch (err) {
      // A single undecodable frame must not abort the whole analysis — keep the
      // segment, just without a preview (the UI + AI handle a null thumbPath).
      if (err && err.isCancelled) throw err;
      out.push({ ...seg, thumbPath: null });
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    if (jobId && jobs.isCancelled(jobId)) throw new jobs.CancelledError();
    if (onProgress) onProgress(((i + 1) / segments.length) * 100);
  }
  return out;
}

/** Read a thumbnail as a base64 data URI for OpenRouter vision requests. */
function thumbAsDataUri(thumbPath) {
  const buf = fs.readFileSync(thumbPath);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

module.exports = { extractThumbs, thumbAsDataUri };
