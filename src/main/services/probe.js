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

async function probe(filePath, { jobId, inputArgs = [] } = {}) {
  const data = await ffprobeJson([
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    ...inputArgs,
    filePath,
  ], { jobId });

  const video = (data.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) || {};
  const tracks = (data.streams || []).filter((s) => s.codec_type === 'audio');
  const audio = tracks[0];
  const duration = Number(video.duration) || Number(data.format?.duration) || 0;
  const startTime = Number(data.format?.start_time ?? video.start_time) || 0;
  const rotation = Number(video.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation
    ?? video.tags?.rotate) || 0;
  const quarterTurn = Math.abs(rotation) % 180 === 90;
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
    startTime,
    videoStreamIndex: video.index,
    width: Number(quarterTurn ? video.height : video.width) || 0,
    height: Number(quarterTurn ? video.width : video.height) || 0,
    // Prefer avg_frame_rate (real playback rate); fall back to r_frame_rate. Both are
    // capped in parseFps so a container timebase (e.g. 90000/1) never shows as fps.
    fps: parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate),
    videoCodec: video.codec_name || 'unknown',
    audioCodec: audio ? audio.codec_name : null,
    hasAudio: !!audio,
    audioTracks: tracks.map((track, index) => ({
      index, codec: track.codec_name || 'unknown',
      title: track.tags?.title || track.tags?.TITLE || '', language: track.tags?.language || '',
    })),
    sizeBytes: size,
  };
}

module.exports = { probe };
