'use strict';

/** Shared helpers to run ffmpeg/ffprobe as child processes. */

const { spawn } = require('child_process');
const { ffmpegPath, ffprobePath } = require('../binaries');
const jobs = require('../jobs');

/** Run ffprobe and return parsed JSON. */
function ffprobeJson(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error('ffprobe JSON parse failed: ' + e.message));
      }
    });
  });
}

/**
 * Run ffmpeg. Optionally collects stderr (for scene/showinfo parsing) and reports
 * progress via -progress pipe:1 when totalDurationSec + onProgress are provided.
 */
function runFfmpeg(args, { jobId, totalDurationSec, onProgress, collectStderr } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    if (jobId) jobs.register(jobId, proc);

    let stderr = '';
    let stdout = '';

    if (collectStderr) {
      proc.stderr.on('data', (d) => (stderr += d.toString()));
    } else {
      proc.stderr.on('data', () => {}); // drain to avoid backpressure
    }

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (onProgress && totalDurationSec) {
        const m = /out_time_us=(\d+)/g;
        let last;
        let match;
        while ((match = m.exec(stdout)) !== null) last = match[1];
        if (last) {
          const sec = Number(last) / 1e6;
          const pct = Math.max(0, Math.min(100, (sec / totalDurationSec) * 100));
          onProgress(pct);
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (jobId && jobs.isCancelled(jobId)) return reject(new Error('cancelled'));
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
      resolve({ stderr, stdout });
    });
  });
}

module.exports = { ffprobeJson, runFfmpeg };
