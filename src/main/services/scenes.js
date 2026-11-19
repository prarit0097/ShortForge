'use strict';

/**
 * Scene-change detection. Default path runs the ffmpeg scene filter and parses
 * showinfo timestamps. A keyframe-only fallback (fast, no full decode) is used for
 * very large files or when the user opts for speed.
 */

const { spawn } = require('child_process');
const { ffmpegPath, ffprobePath } = require('../binaries');
const jobs = require('../jobs');

/**
 * Full scene detection. Decodes video (no re-encode) and emits scene scores.
 * @returns {Promise<number[]>} sorted scene-change timestamps (seconds)
 */
function detectScenes(filePath, { threshold = 0.4, jobId, totalDurationSec, onProgress, videoStreamIndex, inputArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    if (jobId && jobs.isCancelled(jobId)) return reject(new jobs.CancelledError());
    const args = [
      '-hide_banner', '-nostdin', ...inputArgs,
      '-i', filePath,
      '-map', Number.isInteger(videoStreamIndex) ? `0:${videoStreamIndex}` : '0:V:0',
      '-filter:v', `select='gt(scene,${threshold})',showinfo`,
      '-an',
      '-f', 'null', '-',
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    if (jobId) jobs.register(jobId, proc);

    const times = [];
    let buffer = '';

    proc.stderr.on('data', (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const sm = line.match(/pts_time:([\d.]+)/);
        if (sm && line.includes('showinfo')) {
          times.push(Number(sm[1]));
        }
        if (onProgress && totalDurationSec) {
          const tm = line.match(/time=(\d+):(\d+):([\d.]+)/);
          if (tm) {
            const sec = (+tm[1]) * 3600 + (+tm[2]) * 60 + (+tm[3]);
            onProgress(Math.min(100, (sec / totalDurationSec) * 100));
          }
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (jobId && jobs.isCancelled(jobId)) return reject(new jobs.CancelledError());
      if (code !== 0) return reject(new Error(`scene detection failed (exit ${code})`));
      resolve([...new Set(times)].sort((a, b) => a - b));
    });
  });
}

/** Fast fallback: list keyframe (I-frame) timestamps without decoding everything. */
function detectKeyframes(filePath, { jobId, videoStreamIndex, startTime = 0, inputArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    if (jobId && jobs.isCancelled(jobId)) return reject(new jobs.CancelledError());
    const args = [
      '-v', 'error',
      '-select_streams', Number.isInteger(videoStreamIndex) ? String(videoStreamIndex) : 'V:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=best_effort_timestamp_time',
      '-of', 'csv=p=0',
      ...inputArgs,
      filePath,
    ];
    const proc = spawn(ffprobePath, args, { windowsHide: true });
    if (jobId) jobs.register(jobId, proc);
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (jobId && jobs.isCancelled(jobId)) return reject(new jobs.CancelledError());
      if (code !== 0) return reject(new Error(`keyframe scan failed (exit ${code})`));
      const times = out.split('\n')
        .map((line) => Number.parseFloat(line) - startTime)
        .filter((time) => Number.isFinite(time) && time >= -0.000001)
        .map((time) => Math.max(0, time))
        .sort((a, b) => a - b);
      resolve([...new Set(times)]);
    });
  });
}

module.exports = { detectScenes, detectKeyframes };
