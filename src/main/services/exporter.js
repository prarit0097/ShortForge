'use strict';

/**
 * Batch export of processed clips to a user-chosen folder. Since everything is local
 * this is a fast file copy (rename/move when on the same volume). Runs with bounded
 * concurrency and reports progress.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function copyOne(srcPath, destDir) {
  const base = path.basename(srcPath);
  let dest = path.join(destDir, base);
  // Avoid clobbering existing files.
  if (fs.existsSync(dest)) {
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    dest = path.join(destDir, `${stem}_${Date.now()}${ext}`);
  }
  await fsp.copyFile(srcPath, dest);
  return dest;
}

/**
 * @param clips array of { outputPath, fileName }
 * @param destDir target folder
 */
async function exportClips(clips, destDir, { concurrency = 2, onProgress } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const total = clips.length;
  let done = 0;
  const results = [];

  const queue = [...clips];
  async function worker() {
    while (queue.length) {
      const clip = queue.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        const dest = await copyOne(clip.outputPath, destDir);
        results.push({ ...clip, exportedPath: dest, ok: true });
      } catch (err) {
        results.push({ ...clip, ok: false, error: err.message });
      }
      done += 1;
      if (onProgress) onProgress((done / total) * 100, done, total);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { exportClips };
