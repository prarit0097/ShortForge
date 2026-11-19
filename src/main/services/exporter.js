'use strict';

/**
 * Batch export with bounded concurrency. Cancellation stops the queue and lets
 * started copies finish before the job reports its results.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const jobs = require('../jobs');

const unsupportedLink = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL']);

async function copyOne(srcPath, destDir, tempPath) {
  const base = path.basename(srcPath);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  await fsp.copyFile(srcPath, tempPath, fs.constants.COPYFILE_EXCL);
  let canLink = true;
  for (let i = 0; ; i++) {
    const dest = path.join(destDir, i ? `${stem} (${i + 1})${ext}` : base);
    try {
      if (canLink) {
        try {
          await fsp.link(tempPath, dest);
          return dest;
        } catch (err) {
          if (!unsupportedLink.has(err.code)) throw err;
          await fsp.rm(tempPath);
          canLink = false;
        }
      }
      // Volumes without hard links still need exclusive creation. The final
      // name can be visible while the fallback copy is running.
      await fsp.copyFile(srcPath, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

/**
 * @param clips array of { outputPath, fileName }
 * @param destDir target folder
 */
async function exportClips(clips, destDir, { concurrency = 2, onProgress, jobId } = {}) {
  const total = clips.length;
  const results = clips.map((clip) => ({ ...clip, status: 'cancelled' }));
  const isCancelled = () => jobId && jobs.isCancelled(jobId);
  if (!total || isCancelled()) return results;

  await fsp.mkdir(destDir, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(destDir, '.shortforge-export-'));
  let done = 0;

  let next = 0;
  async function worker() {
    while (next < total && !isCancelled()) {
      const i = next++;
      const clip = clips[i];
      const tempPath = path.join(tempDir, String(i));
      try {
        const dest = await copyOne(clip.outputPath, destDir, tempPath);
        results[i] = { ...clip, exportedPath: dest, status: 'ready' };
      } catch (err) {
        results[i] = { ...clip, status: 'failed', error: err.message };
      } finally {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
      }
      done += 1;
      if (onProgress) onProgress((done / total) * 100, done, total);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => worker());
  try {
    await Promise.all(workers);
  } finally {
    await fsp.rmdir(tempDir).catch(() => {});
  }
  return results;
}

module.exports = { exportClips };
