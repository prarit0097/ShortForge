'use strict';

/** Extracts a single representative frame per segment (UI previews + AI vision input). */

const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./ffmpeg-util');

/**
 * Extract one JPEG near each segment start.
 * @param scale width in px (small for AI/cost, larger for crisp UI). -1 keeps aspect.
 * @returns segments enriched with { thumbPath }
 */
async function extractThumbs(filePath, segments, outDir, { jobId, scale = 360, onProgress } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Grab a frame a hair after the start to avoid black transition frames.
    const at = Math.max(0, seg.start + Math.min(0.5, seg.duration / 4));
    const thumbPath = path.join(outDir, `seg_${String(seg.index).padStart(4, '0')}.jpg`);
    // eslint-disable-next-line no-await-in-loop
    await runFfmpeg(
      [
        '-hide_banner', '-y',
        '-ss', String(at),
        '-i', filePath,
        '-frames:v', '1',
        '-vf', `scale=${scale}:-1`,
        '-q:v', '3',
        thumbPath,
      ],
      { jobId }
    );
    out.push({ ...seg, thumbPath });
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
