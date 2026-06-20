'use strict';

/** Reads video metadata (duration, resolution, fps, codec, size) via ffprobe. */

const fs = require('fs');
const path = require('path');
const { ffprobeJson } = require('./ffmpeg-util');

function parseFps(rate) {
  if (!rate || rate === '0/0') return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? +(n / d).toFixed(3) : n;
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
    fps: parseFps(video.r_frame_rate),
    videoCodec: video.codec_name || 'unknown',
    audioCodec: audio ? audio.codec_name : null,
    hasAudio: !!audio,
    sizeBytes: size,
  };
}

module.exports = { probe };
