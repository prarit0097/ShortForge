'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.flv', '.wmv', '.ts', '.mpg', '.mpeg',
]);
const TEMP_SUFFIX = /\.(?:part|partial|tmp|temp|crdownload)$/i;

function isRecordingName(name) {
  const ext = path.extname(name);
  return MEDIA_EXTENSIONS.has(ext.toLowerCase()) && !TEMP_SUFFIX.test(path.basename(name, ext));
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function fingerprint(stat) {
  return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Observe one approved folder. The initial scan baselines existing recordings
 * by default. stop() prevents further notifications, even during an in-flight scan.
 */
async function watchRecordings(folder, {
  onRecording, onError, quietMs = 10000, pollMs = 1000, includeExisting = false,
} = {}) {
  if (typeof onRecording !== 'function') throw new TypeError('Provide an onRecording callback.');
  if (!Number.isFinite(quietMs) || quietMs < 0 ||
      !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 2147483647) {
    throw new RangeError('Use a nonnegative quiet period and a positive polling interval.');
  }
  const approved = path.resolve(folder);
  if (!(await fs.lstat(approved)).isDirectory()) throw new Error('Select a regular folder to watch.');
  const root = await fs.realpath(approved);
  const rootIdentity = identity(await fs.lstat(root, { bigint: true }));
  let observed = new Map();
  let timer;
  let stopped = false;
  let lastError;

  async function checkRoot() {
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory() || identity(stat) !== rootIdentity) {
      throw new Error('The watched folder was replaced. Select it again to resume watching.');
    }
  }

  async function reportError(error) {
    if (stopped || !onError) return;
    try {
      await onError(error);
    } catch (_) {
      // Keep an unavailable error listener from interrupting the watcher.
    }
  }

  async function scan(initial = false) {
    await checkRoot();
    const current = new Map();
    const ready = [];
    for (const name of await fs.readdir(root)) {
      if (stopped) return;
      if (!isRecordingName(name)) continue;
      const previous = observed.get(name);
      const filePath = path.join(root, name);
      let stat;
      try {
        stat = await fs.lstat(filePath, { bigint: true });
      } catch (err) {
        if (['EBUSY', 'EACCES', 'EPERM'].includes(err.code)) {
          if (previous) current.set(name, previous);
          continue;
        }
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      if (!stat.isFile()) continue;
      const now = performance.now();
      const version = fingerprint(stat);
      if (previous?.version !== version) {
        current.set(name, { version, since: now, emitted: initial && !includeExisting });
      } else {
        current.set(name, previous);
        if (!previous.emitted && stat.size > 0n && now - previous.since >= quietMs) {
          ready.push({ filePath, observation: previous });
        }
      }
    }
    await checkRoot();
    if (stopped) return;
    observed = current;
    for (const { filePath, observation } of ready) {
      // Earlier notifications can take time. Confirm this version still exists
      // before handing its path to the app.
      const stat = await fs.lstat(filePath, { bigint: true }).catch(() => null);
      if (stopped) return;
      if (!stat?.isFile() || fingerprint(stat) !== observation.version) continue;
      observation.emitted = true;
      try {
        await onRecording(filePath);
      } catch (err) {
        await reportError(err);
      }
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(poll, pollMs);
    timer.unref();
  }

  async function poll() {
    try {
      await scan();
      lastError = undefined;
    } catch (err) {
      const message = `${err.code || ''}:${err.message}`;
      if (message !== lastError) await reportError(err);
      lastError = message;
    } finally {
      schedule();
    }
  }

  await scan(true);
  schedule();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      observed.clear();
    },
  };
}

module.exports = { watchRecordings };
