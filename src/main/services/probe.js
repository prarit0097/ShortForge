'use strict';

/** Reads video metadata (duration, resolution, fps, codec, size) via ffprobe. */

const fs = require('fs');
const path = require('path');
const { ffprobeJson } = require('./ffmpeg-util');

const MAX_REASONABLE_FPS = 300; // real footage tops out ~240; higher = container timebase

function parseFps(rate) {
  if (!rate || rate === '0/0') return 0;
  const [n, d] = rate.split('/').map(Number);
  const fps = d ? +(n / d).toFixed(3) : n;
  return Number.isFinite(fps) && fps > 0 && fps <= MAX_REASONABLE_FPS ? fps : 0;
}

async function probe(filePath) {
  const data = await ffprobeJson([
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const video = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  const duration = Number(data.format && data.format.duration) || Number(video.duration) || 0;
  let size = Number(data.format && data.format.size) || 0;
  if (!size) {
    try {
      size = fs.statSync(filePath).size;
    } catch (_) {
      size = 0;
    }
  }

  return {
    path: filePath,
    name: path.basename(filePath),
    duration, // seconds (float)
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    // Prefer avg_frame_rate (real playback rate); fall back to r_frame_rate. Both are
    // capped in parseFps so a container timebase (e.g. 90000/1) never shows as fps.
    fps: parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate),
    videoCodec: video.codec_name || 'unknown',
    audioCodec: audio ? audio.codec_name : null,
    hasAudio: !!audio,
    sizeBytes: size,
  };
}

module.exports = { probe };
