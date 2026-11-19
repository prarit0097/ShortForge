'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AutomationError } = require('./errors');

const DEMUXERS = new Map([
  ['.mp4', 'mov'], ['.mov', 'mov'], ['.m4v', 'mov'],
  ['.mkv', 'matroska'], ['.webm', 'matroska'],
  ['.mpg', 'mpeg'], ['.mpeg', 'mpeg'], ['.ts', 'mpegts'],
  ['.avi', 'avi'], ['.flv', 'flv'], ['.wmv', 'asf'],
]);

function invalidSource() {
  return new AutomationError('INVALID_SOURCE', 'Use a relative path to a regular media file inside the input folder.');
}

function unsupportedMedia() {
  return new AutomationError('UNSUPPORTED_MEDIA', 'This media container is unsupported.');
}

function isWithin(root, filePath) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  // Canonical paths use filesystem casing. Win32 path.relative compares case-insensitively.
  return filePath !== root && filePath.startsWith(prefix);
}

async function resolveLocalMedia(inputRoot, source) {
  if (typeof source !== 'string' || !source || path.posix.isAbsolute(source) ||
      path.win32.isAbsolute(source) || /[<>:"|?*\x00-\x1f]/.test(source)) {
    throw invalidSource();
  }
  const parts = source.split(/[\\/]/);
  const reserved = /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]*\.|$)/i;
  if (parts.some((part) => !part || /[. ]$/.test(part) || reserved.test(part))) throw invalidSource();

  let filePath;
  try {
    const root = await fs.realpath(inputRoot);
    if (process.platform === 'win32' && root.startsWith('\\\\')) throw invalidSource();
    filePath = await fs.realpath(path.join(root, ...parts));
    if (!isWithin(root, filePath) || !(await fs.stat(filePath)).isFile()) {
      throw invalidSource();
    }
  } catch (_) {
    throw invalidSource();
  }

  const demuxer = DEMUXERS.get(path.extname(filePath).toLowerCase());
  if (!demuxer) throw unsupportedMedia();
  return { filePath, demuxer };
}

function localMediaInputArgs(demuxer) {
  if (![...DEMUXERS.values()].includes(demuxer)) throw unsupportedMedia();
  const args = ['-protocol_whitelist', 'file', '-f', demuxer];
  // MOV data references can open a second file. Keep both opt-ins disabled explicitly.
  if (demuxer === 'mov') args.push('-enable_drefs', '0', '-use_absolute_path', '0');
  return args;
}

module.exports = { resolveLocalMedia, localMediaInputArgs, isWithin };
