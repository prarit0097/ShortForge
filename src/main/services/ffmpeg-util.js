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
    let progressBuf = ''; // holds an incomplete trailing line across data events

    // Always accumulate stderr so failures carry FFmpeg's diagnostic output.
    // Keep only the tail to bound memory on long, chatty encodes. The
    // `collectStderr` flag controls whether stderr is returned on resolve.
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 64000) stderr = stderr.slice(-32000);
    });

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (stdout.length > 64000) stdout = stdout.slice(-32000); // bound memory on long encodes
      if (onProgress && totalDurationSec) {
        // Buffer until newline so a value split across two chunks is never misread.
        // The trailing \n in the regex guarantees only whole out_time_us values match.
        progressBuf += chunk;
        const nl = progressBuf.lastIndexOf('\n');
        if (nl !== -1) {
          const complete = progressBuf.slice(0, nl + 1);
          progressBuf = progressBuf.slice(nl + 1);
          if (progressBuf.length > 4000) progressBuf = progressBuf.slice(-2000);
          const m = /out_time_us=(\d+)\n/g;
          let last;
          let match;
          while ((match = m.exec(complete)) !== null) last = match[1];
          if (last) {
            const sec = Number(last) / 1e6;
            const pct = Math.max(0, Math.min(100, (sec / totalDurationSec) * 100));
            onProgress(pct);
          }
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (jobId && jobs.isCancelled(jobId)) return reject(new jobs.CancelledError());
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
      resolve({ stderr, stdout });
    });
  });
}

module.exports = { ffprobeJson, runFfmpeg };
