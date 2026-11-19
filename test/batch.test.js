'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jobs = require('../src/main/jobs');
const { cutAll } = require('../src/main/services/cutter');
const { exportClips } = require('../src/main/services/exporter');
const { ffmpegPath } = require('../src/main/binaries');

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const renderOptions = { hwAccel: 'cpu', ratioKey: 'original', concurrency: 1 };
const segment = { index: 0, start: 0, end: 1, duration: 1, title: 'Clip' };

function makeSource(dir) {
  const input = path.join(dir, 'source.mp4');
  const fixture = spawnSync(ffmpegPath, [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=1', '-c:v', 'libx264', input,
  ], { timeout: 15000, windowsHide: true });
  assert.equal(fixture.status, 0, String(fixture.stderr));
  return input;
}

test('render returns an outcome for every clip in submission order', async (t) => {
  const dir = await workspace(t);
  const input = makeSource(dir);
  const badSegment = { ...segment, index: 1, subtitlePath: path.join(dir, 'missing.srt') };
  const results = await cutAll(input, [segment, badSegment], path.join(dir, 'clips'), renderOptions);
  assert.deepEqual(results.map(({ index, status }) => [index, status]), [[0, 'ready'], [1, 'failed']]);
  assert.ok((await fs.stat(results[0].outputPath)).size > 0);
  assert.match(results[1].error, /ffmpeg/);
  assert.equal(results[1].outputPath, undefined);
});

test('failed or cancelled rerender leaves the previous output untouched', async (t) => {
  const dir = await workspace(t);
  const clips = path.join(dir, 'clips');
  const input = makeSource(dir);
  const [first] = await cutAll(input, [segment], clips, renderOptions);
  const before = await fs.readFile(first.outputPath);

  const [failed] = await cutAll(input, [
    { ...segment, subtitlePath: path.join(dir, 'missing.srt') },
  ], clips, renderOptions);
  assert.equal(failed.status, 'failed');

  const jobId = 'cancel-render';
  jobs.create(jobId);
  t.after(() => jobs.done(jobId));
  jobs.cancel(jobId);
  const cancelled = await cutAll(input, [segment], clips, { ...renderOptions, jobId });
  assert.deepEqual(cancelled, [{ index: 0, status: 'cancelled' }]);
  assert.deepEqual(await fs.readFile(first.outputPath), before);
  assert.deepEqual((await fs.readdir(clips, { recursive: true })).filter((p) => /\.mp4$/.test(p))
    .map((p) => path.join(clips, p)), [first.outputPath]);
});

test('render fails when no frames are written', async (t) => {
  const dir = await workspace(t);
  const input = makeSource(dir);
  const clips = path.join(dir, 'clips');
  const results = await cutAll(input, [{ ...segment, start: 2, end: 3 }], clips, renderOptions);
  assert.equal(results[0].status, 'failed');
  assert.deepEqual(await fs.readdir(clips), []);
});

test('render fails when audio packets are written without video frames', async (t) => {
  const dir = await workspace(t);
  const input = path.join(dir, 'longer-audio.mp4');
  const fixture = spawnSync(ffmpegPath, [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'aac', input,
  ], { timeout: 15000, windowsHide: true });
  assert.equal(fixture.status, 0, String(fixture.stderr));

  const [result] = await cutAll(input, [{ ...segment, start: 2, end: 3 }], path.join(dir, 'clips'), {
    ...renderOptions, hasAudio: true,
  });
  assert.equal(result.status, 'failed');
});

test('export cancellation finishes the current copy and stops queued files', async (t) => {
  const dir = await workspace(t);
  const dest = path.join(dir, 'dest');
  const source = path.join(dir, 'source.mp4');
  await fs.writeFile(source, 'source');
  const jobId = 'cancel-export';
  jobs.create(jobId);
  t.after(() => jobs.done(jobId));
  const copyFile = fs.copyFile;
  t.mock.method(fs, 'copyFile', (...args) => {
    jobs.cancel(jobId);
    return copyFile(...args);
  });

  const results = await exportClips(Array.from({ length: 3 }, () => ({ outputPath: source })), dest, {
    jobId, concurrency: 1,
  });
  assert.deepEqual(results.map(({ status }) => status), ['ready', 'cancelled', 'cancelled']);
  assert.deepEqual(await fs.readdir(dest), ['source.mp4']);
  assert.equal(await fs.readFile(results[0].exportedPath, 'utf8'), 'source');
});

test('concurrent exports with the same basename preserve all contents', async (t) => {
  const dir = await workspace(t);
  const dest = path.join(dir, 'dest');
  await fs.mkdir(dest);
  await fs.writeFile(path.join(dest, 'clip.mp4'), 'existing');
  const clips = await Promise.all(['one', 'two', 'three'].map(async (name) => {
    const source = path.join(dir, name);
    await fs.mkdir(source);
    const outputPath = path.join(source, 'clip.mp4');
    await fs.writeFile(outputPath, name);
    return { outputPath };
  }));

  const results = await exportClips(clips, dest, { concurrency: 3 });
  assert.equal(new Set(results.map(({ exportedPath }) => exportedPath)).size, 3);
  const contents = await Promise.all((await fs.readdir(dest)).map((file) => fs.readFile(path.join(dest, file), 'utf8')));
  assert.deepEqual(contents.sort(), ['existing', 'one', 'three', 'two']);
});

test('export on a volume without hard links frees staging space before copying to the final name', async (t) => {
  const dir = await workspace(t);
  const dest = path.join(dir, 'dest');
  const source = path.join(dir, 'source.mp4');
  const final = path.join(dest, 'source.mp4');
  await fs.writeFile(source, 'source');

  let stagingPath;
  t.mock.method(fs, 'link', (staged) => {
    stagingPath = staged;
    throw Object.assign(new Error('Links unsupported'), { code: 'ENOTSUP' });
  });
  const copyFile = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (from, to, mode) => {
    if (to === final) {
      assert.equal(from, source);
      await assert.rejects(fs.stat(stagingPath), { code: 'ENOENT' });
    }
    return copyFile(from, to, mode);
  });

  const [result] = await exportClips([{ outputPath: source }], dest);
  assert.equal(result.status, 'ready', result.error);
  assert.equal(await fs.readFile(final, 'utf8'), 'source');
});
