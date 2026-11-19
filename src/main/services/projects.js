'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ASPECT_RATIOS, REFRAME_MODES } = require('../constants');

const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_CLIPS = 10000;

function projectSettings(input = {}) {
  input = input || {};
  const result = {};
  for (const [key, values] of Object.entries({
    aspectRatio: Object.keys(ASPECT_RATIOS), reframeMode: Object.keys(REFRAME_MODES),
    outputQuality: ['high', 'balanced', 'max'], scanMode: ['accurate', 'fast'],
  })) {
    if (values.includes(input[key])) result[key] = input[key];
  }
  for (const key of ['enhance', 'burnTitle', 'burnCaptions']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  for (const key of ['targetLengthSec', 'minLengthSec', 'maxLengthSec', 'sceneThreshold']) {
    if (Number.isFinite(input[key]) && input[key] > 0 && input[key] <= 600) result[key] = input[key];
  }
  if (['mix', 'none'].includes(input.audioTrack) || (Number.isInteger(input.audioTrack) && input.audioTrack >= 0)) {
    result.audioTrack = input.audioTrack;
  }
  return result;
}

async function sourceFingerprint(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || /^[\\/]{2}/.test(sourcePath)) {
    throw new Error('Project source must be an absolute local file path.');
  }
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) throw new Error('Project source is missing or is not a video file.');
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

async function cachedRender(cacheRoot, absolutePath) {
  if (typeof absolutePath !== 'string' || path.extname(absolutePath).toLowerCase() !== '.mp4') return null;
  try {
    const [root, file] = await Promise.all([fs.realpath(cacheRoot), fs.realpath(absolutePath)]);
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    return (await fs.stat(file)).isFile() ? { file, relative } : null;
  } catch {
    return null;
  }
}

function projectClips(items) {
  if (!Array.isArray(items) || items.length > MAX_CLIPS) throw new Error('Invalid project clip list.');
  const indices = new Set();
  return items.map((clip) => {
    const { index, start, end } = clip || {};
    if (!Number.isSafeInteger(index) || index < 0 || indices.has(index) ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error('Invalid project clip range or ID.');
    }
    indices.add(index);
    const result = { index, start, end, duration: end - start, selected: clip.selected !== false };
    for (const key of ['title', 'caption', 'aiDescription', 'reason', 'eventType', 'signal']) {
      if (typeof clip[key] === 'string') result[key] = clip[key].slice(0, 1000);
    }
    if (Number.isFinite(clip.cropBias)) result.cropBias = Math.max(-1, Math.min(1, clip.cropBias));
    if (Number.isFinite(clip.peak) && clip.peak >= 0) result.peak = clip.peak;
    if (Number.isFinite(clip.viralityScore)) result.viralityScore = clip.viralityScore;
    if (Number.isFinite(clip.confidence)) result.confidence = clip.confidence;
    for (const key of ['manual', 'titleEdited', 'cropEdited', 'aiKeep']) {
      if (typeof clip[key] === 'boolean') result[key] = clip[key];
    }
    if (Array.isArray(clip.hashtags)) {
      result.hashtags = clip.hashtags.filter((item) => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 100));
    }
    return result;
  });
}

async function saveProject(filePath, draft, { cacheRoot }) {
  const source = await sourceFingerprint(draft.sourcePath);
  const segments = projectClips(draft.segments);
  for (let i = 0; i < segments.length; i++) {
    const render = await cachedRender(cacheRoot, draft.segments[i].outputPath);
    if (render) segments[i].output = render.relative;
  }
  const payload = JSON.stringify({
    version: 1, sourcePath: draft.sourcePath, source,
    mode: draft.mode === 'gameplay' ? 'gameplay' : 'coverage',
    settings: projectSettings(draft.settings), segments,
  });
  if (Buffer.byteLength(payload) > MAX_PROJECT_BYTES) throw new Error('Project is too large.');
  const temporary = path.join(path.dirname(filePath), `.shortforge-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, payload, { flag: 'wx' });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function openProject(filePath, { cacheRoot, cacheRootForSource }) {
  const file = await fs.open(filePath, 'r');
  let project;
  try {
    const buffer = Buffer.alloc(MAX_PROJECT_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_PROJECT_BYTES) throw new Error('Project is too large.');
    project = JSON.parse(buffer.toString('utf8', 0, count));
  } finally {
    await file.close();
  }
  if (project?.version !== 1) throw new Error('Unsupported ShortForge project version.');
  const segments = projectClips(project.segments);
  const source = await sourceFingerprint(project.sourcePath);
  const sourceChanged = source.size !== project.source?.size || source.mtimeMs !== project.source?.mtimeMs;
  if (!sourceChanged) {
    const root = cacheRootForSource ? cacheRootForSource(project.sourcePath) : cacheRoot;
    for (let i = 0; i < segments.length; i++) {
      const output = project.segments[i].output;
      if (typeof output !== 'string' || path.isAbsolute(output)) continue;
      const render = await cachedRender(root, path.join(root, output));
      if (render) {
        segments[i].outputPath = render.file;
        segments[i].fileName = path.basename(render.file);
      }
    }
  }
  return {
    sourcePath: project.sourcePath, sourceChanged, segments,
    mode: project.mode === 'gameplay' ? 'gameplay' : 'coverage', settings: projectSettings(project.settings || {}),
  };
}

module.exports = { saveProject, openProject };
