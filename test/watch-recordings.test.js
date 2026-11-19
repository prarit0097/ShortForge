'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { watchRecordings } = require('../src/main/services/watch-recordings');

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-watch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(predicate) {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), 'The watcher did not emit the expected event');
}

async function watch(t, dir, options = {}) {
  const events = [];
  const watcher = await watchRecordings(dir, {
    quietMs: 100,
    pollMs: 10,
    onRecording: (file) => events.push(file),
    ...options,
  });
  t.after(() => watcher.stop());
  return { events, watcher };
}

test('baselines old recordings and emits an existing name after it is written again', async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, 'existing.MKV');
  await fs.writeFile(file, 'old');
  const { events } = await watch(t, dir);
  await delay(160);
  assert.deepEqual(events, []);

  await fs.writeFile(file, 'updated recording');
  await waitFor(() => events.length);
  await delay(160);
  assert.deepEqual(events, [file]);
});

test('emits once after a new recording stops growing', async (t) => {
  const dir = await workspace(t);
  const { events } = await watch(t, dir, { quietMs: 200 });
  const file = path.join(dir, 'capture.mkv');
  await fs.writeFile(file, 'first');
  await delay(65);
  await fs.appendFile(file, 'second');
  await delay(65);
  await fs.appendFile(file, 'third');
  await delay(125);
  assert.deepEqual(events, []);

  await waitFor(() => events.length);
  await delay(250);
  assert.deepEqual(events, [file]);
});

test('ignores temp files and subdirectories, then detects a rename into a supported name', async (t) => {
  const dir = await workspace(t);
  const { events } = await watch(t, dir);
  const staging = path.join(dir, 'capture.part.mp4');
  const file = path.join(dir, 'capture.mp4');
  await fs.writeFile(staging, 'partial recording');
  await fs.writeFile(path.join(dir, 'capture.mkv.tmp'), 'temp recording');
  await fs.mkdir(path.join(dir, 'nested'));
  await fs.writeFile(path.join(dir, 'nested', 'clip.mkv'), 'other recording');
  await delay(160);
  assert.deepEqual(events, []);

  await fs.rename(staging, file);
  await waitFor(() => events.length);
  assert.deepEqual(events, [file]);
});

test('detects same-name replacement with the same size and mtime', async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, 'capture.mkv');
  const staging = path.join(dir, 'incoming.part');
  const timestamp = new Date('2025-01-01T00:00:00Z');
  await fs.writeFile(file, 'old');
  await fs.utimes(file, timestamp, timestamp);
  const { events } = await watch(t, dir);
  await fs.writeFile(staging, 'new');
  await fs.utimes(staging, timestamp, timestamp);
  await fs.rename(staging, file);

  await waitFor(() => events.length);
  assert.deepEqual(events, [file]);
});

test('stop prevents future emissions even with files already pending', async (t) => {
  const dir = await workspace(t);
  const { events, watcher } = await watch(t, dir);
  await fs.writeFile(path.join(dir, 'pending.mkv'), 'partial');
  await delay(35);
  watcher.stop();
  watcher.stop();
  await fs.writeFile(path.join(dir, 'later.mp4'), 'new file');
  await delay(200);
  assert.deepEqual(events, []);
});

test('never emits symbolic links to recordings', async (t) => {
  const dir = await workspace(t);
  const { events } = await watch(t, dir);
  const target = path.join(dir, 'outside.dat');
  await fs.writeFile(target, 'data');
  try {
    await fs.symlink(target, path.join(dir, 'linked.mkv'), 'file');
  } catch (err) {
    if (process.platform !== 'win32' || !['EACCES', 'EPERM'].includes(err.code)) throw err;
    return t.skip('This Windows account cannot create file symlinks');
  }
  await delay(180);
  assert.deepEqual(events, []);
});

test('requires approval again for a replacement directory at the watched path', async (t) => {
  const root = await workspace(t);
  const dir = path.join(root, 'captures');
  const errors = [];
  await fs.mkdir(dir);
  const { events } = await watch(t, dir, { onError: (err) => errors.push(err) });
  await fs.rename(dir, path.join(root, 'old-captures'));
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'unapproved.mkv'), 'recording');
  await waitFor(() => errors.some((err) => /folder was replaced/.test(err.message)));
  await delay(180);
  assert.deepEqual(events, []);
});
