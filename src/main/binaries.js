'use strict';

/**
 * Resolves bundled ffmpeg / ffprobe binary paths for both dev and packaged builds.
 * In a packaged app the binaries live in app.asar.unpacked (see asarUnpack in package.json).
 */

const { app } = require('electron');

function unpacked(p) {
  if (!p) return p;
  // When packaged, static binaries are extracted next to the asar archive.
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

let ffmpegPath = null;
let ffprobePath = null;

try {
  ffmpegPath = unpacked(require('ffmpeg-static'));
} catch (err) {
  console.error('[binaries] ffmpeg-static not found:', err.message);
}

try {
  // ffprobe-static exposes { path }
  const ffprobeStatic = require('ffprobe-static');
  ffprobePath = unpacked(ffprobeStatic && ffprobeStatic.path);
} catch (err) {
  console.error('[binaries] ffprobe-static not found:', err.message);
}

function assertBinaries() {
  if (!ffmpegPath || !ffprobePath) {
    throw new Error(
      'FFmpeg/FFprobe binaries are missing. Run "npm install" to fetch ffmpeg-static and ffprobe-static.'
    );
  }
}

module.exports = {
  get ffmpegPath() {
    return ffmpegPath;
  },
  get ffprobePath() {
    return ffprobePath;
  },
  assertBinaries,
};
