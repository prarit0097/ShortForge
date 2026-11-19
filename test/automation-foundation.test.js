'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setImmediate } = require('node:timers/promises');
const { resolveLocalMedia, localMediaInputArgs } = require('../src/automation/local-media');
const { createJobQueue } = require('../src/automation/job-queue');
const jobs = require('../src/main/jobs');

test('local media resolves a regular file and forces a restricted container input', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-media-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'media');
  const sibling = path.join(temp, 'media-outside');
  const file = path.join(root, 'recordings', 'example.MOV');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(sibling);
  await fs.writeFile(file, 'example');
  await fs.writeFile(path.join(sibling, 'outside.mp4'), 'example');
  await fs.writeFile(path.join(root, 'playlist.m3u8'), 'example');
  await fs.mkdir(path.join(root, 'directory.mp4'));
  await fs.symlink(sibling, path.join(root, 'junction'), 'junction');

  assert.deepEqual(await resolveLocalMedia(root, 'recordings/example.MOV'), {
    filePath: await fs.realpath(file), demuxer: 'mov',
  });
  if (process.platform === 'win32') {
    assert.deepEqual(await resolveLocalMedia(root.toUpperCase(), 'RECORDINGS/example.mov'), {
      filePath: file, demuxer: 'mov',
    });
  }
  assert.deepEqual(localMediaInputArgs('mov'), [
    '-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0',
  ]);
  assert.deepEqual(localMediaInputArgs('matroska'), ['-protocol_whitelist', 'file', '-f', 'matroska']);
  assert.throws(() => localMediaInputArgs('concat'), { code: 'UNSUPPORTED_MEDIA' });
  for (const source of [file, '../media-outside/outside.mp4', 'junction/outside.mp4',
    'C:outside.mp4', '\\server\\share\\outside.mp4', 'recordings/example.MOV:stream',
    'missing.mp4', 'playlist.m3u8', 'directory.mp4']) {
    await assert.rejects(resolveLocalMedia(root, source), (err) =>
      ['INVALID_SOURCE', 'UNSUPPORTED_MEDIA'].includes(err.code) && !err.message.includes(temp));
  }
});

test('queue bounds work, tracks progress and cancellation, and evicts old results', async () => {
  const queue = createJobQueue({ concurrency: 1, maxQueued: 1, maxRetained: 2 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstId = queue.submit(async ({ jobId, report }) => {
    assert.equal(jobId, firstId);
    report({ stage: 'cut', percent: 40.4, message: 'private file path' });
    await firstGate;
    assert.equal(jobs.isCancelled(jobId), true);
    return { shouldBeDiscarded: true };
  });
  let secondRan = false;
  const secondId = queue.submit(() => { secondRan = true; });
  assert.equal(queue.get(firstId).state, 'queued');
  assert.equal(queue.get(secondId).state, 'queued');
  assert.throws(() => queue.submit(() => {}), { code: 'QUEUE_FULL' });

  await setImmediate();
  assert.deepEqual(queue.get(firstId), { jobId: firstId, state: 'running', stage: 'cut', percent: 40 });
  assert.equal(queue.cancel(secondId), true);
  assert.equal(queue.get(secondId).state, 'cancelled');
  assert.equal(queue.cancel(firstId), true);
  assert.equal(queue.get(firstId).state, 'cancelling');
  assert.equal(queue.cancel(firstId), false);
  releaseFirst();
  await setImmediate();
  assert.equal(secondRan, false);
  assert.equal(queue.get(firstId).state, 'cancelled');
  assert.equal(queue.get(firstId).result, undefined);

  const doneId = queue.submit(() => ({ filenames: ['clip.mp4'] }));
  await setImmediate();
  assert.equal(queue.get(secondId), null);
  const done = queue.get(doneId);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.percent, 100);
  done.result.filenames.push('changed.mp4');
  assert.deepEqual(queue.get(doneId).result, { filenames: ['clip.mp4'] });
  assert.equal(queue.cancel(doneId), false);
  assert.equal(queue.cancel('unknown'), false);

  const failedId = queue.submit(() => { throw new Error('C:\\secret\\video.mp4'); });
  await setImmediate();
  assert.deepEqual(queue.get(failedId).error, { code: 'JOB_FAILED', message: 'The video job failed.' });
  assert.equal(queue.get(failedId).state, 'failed');
});
