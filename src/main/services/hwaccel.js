'use strict';

/**
 * Detects a usable hardware H.264 encoder (NVENC > QSV > AMF) and returns the
 * matching ffmpeg encode flags for a chosen quality level. Falls back to libx264
 * (CPU) when none work. All paths force yuv420p output for broad platform/player
 * compatibility (social apps reject 10-bit / 4:4:4).
 */

const { spawn } = require('child_process');
const { ffmpegPath } = require('../binaries');

// Probe names used for hardware detection.
const ENCODER_NAMES = { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', cpu: 'libx264' };

// Quality presets. Lower CRF/CQ = higher quality. 'high' ≈ visually lossless.
const QUALITY = {
  balanced: { crf: 21, x264: 'veryfast', nvCq: 23, nvPreset: 'p4', qsvQ: 23, qsvPreset: 'veryfast', amfQp: 24, audio: '160k' },
  high: { crf: 18, x264: 'medium', nvCq: 19, nvPreset: 'p6', qsvQ: 19, qsvPreset: 'slow', amfQp: 20, audio: '192k' },
  max: { crf: 15, x264: 'slow', nvCq: 16, nvPreset: 'p7', qsvQ: 15, qsvPreset: 'slower', amfQp: 16, audio: '256k' },
};

function videoArgs(encKey, q) {
  switch (encKey) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', q.nvPreset, '-rc', 'vbr', '-cq', String(q.nvCq), '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(q.qsvQ), '-preset', q.qsvPreset, '-pix_fmt', 'yuv420p'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q.amfQp), '-qp_p', String(q.amfQp), '-pix_fmt', 'yuv420p'];
    default:
      return ['-c:v', 'libx264', '-preset', q.x264, '-crf', String(q.crf), '-pix_fmt', 'yuv420p'];
  }
}

let cached = null;

function probeEncoder(encoderName) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=128x128:d=0.1',
      '-c:v', encoderName, '-f', 'null', '-',
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/** Returns { available:[...], best:'nvenc'|'qsv'|'amf'|'cpu' }. Cached after first run. */
async function detect() {
  if (cached) return cached;
  const available = [];
  for (const key of ['nvenc', 'qsv', 'amf']) {
    // eslint-disable-next-line no-await-in-loop
    if (await probeEncoder(ENCODER_NAMES[key])) available.push(key);
  }
  available.push('cpu');
  cached = { available, best: available[0] };
  return cached;
}

/**
 * Resolve encoder + audio args for a preference ('auto' picks best detected) and a
 * quality level. Returns { vargs, audioBitrate }.
 */
async function encoderArgs(pref, qualityLevel) {
  const q = QUALITY[qualityLevel] || QUALITY.high;
  let encKey = pref;
  if (!encKey || encKey === 'auto' || !ENCODER_NAMES[encKey]) {
    encKey = (await detect()).best;
  }
  return { vargs: videoArgs(encKey, q), audioBitrate: q.audio };
}

module.exports = { detect, encoderArgs, ENCODER_NAMES, QUALITY };
