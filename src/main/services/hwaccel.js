'use strict';

/**
 * Detects a usable hardware H.264 encoder (NVENC > QSV > AMF) and returns the
 * matching ffmpeg encode flags. Falls back to libx264 (CPU) when none work.
 */

const { spawn } = require('child_process');
const { ffmpegPath } = require('../binaries');

const ENCODERS = {
  nvenc: {
    name: 'h264_nvenc',
    args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
  },
  qsv: {
    name: 'h264_qsv',
    args: ['-c:v', 'h264_qsv', '-global_quality', '23', '-preset', 'veryfast'],
  },
  amf: {
    name: 'h264_amf',
    args: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'],
  },
  cpu: {
    name: 'libx264',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'],
  },
};

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
    if (await probeEncoder(ENCODERS[key].name)) available.push(key);
  }
  available.push('cpu');
  cached = { available, best: available[0] };
  return cached;
}

/** Resolve the encoder args for a user preference ('auto' picks the best detected). */
async function encoderArgs(pref) {
  if (pref && pref !== 'auto' && ENCODERS[pref]) return ENCODERS[pref].args;
  const { best } = await detect();
  return ENCODERS[best].args;
}

module.exports = { detect, encoderArgs, ENCODERS };
