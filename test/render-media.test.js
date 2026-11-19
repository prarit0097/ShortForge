'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ffmpegPath } = require('../src/main/binaries');
const jobs = require('../src/main/jobs');
const { cutAll } = require('../src/main/services/cutter');
const { probe } = require('../src/main/services/probe');

test('cancelled jobs stop before probing an input', async (t) => {
  const jobId = 'test-probe-cancel';
  jobs.create(jobId);
  t.after(() => jobs.done(jobId));
  jobs.cancel(jobId);
  await assert.rejects(probe('unused-recording.mp4', { jobId }), { name: 'CancelledError' });
});

test('renders a playable vertical clip from an OBS-style MKV', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-smoke-'));
  const jobId = 'test-render-media';
  jobs.create(jobId);
  t.after(async () => {
    jobs.done(jobId);
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const source = path.join(workDir, 'gameplay.mkv');
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', source,
  ], { timeout: 15000, windowsHide: true });

  const [result] = await cutAll(source, [{ index: 0, start: 0.25, end: 1, duration: 0.75 }],
    path.join(workDir, 'rendered'), {
      ratioKey: '9:16', reframeMode: 'blur', quality: 'balanced', hwAccel: 'cpu',
      hasAudio: true, srcW: 320, srcH: 180, concurrency: 1, jobId,
    });
  assert.equal(result.status, 'ready', result.error);
  const output = await probe(result.outputPath);
  assert.equal(output.width, 1080);
  assert.equal(output.height, 1920);
  assert.equal(output.videoCodec, 'h264');
  assert.equal(output.audioCodec, 'aac');
  assert.ok(Math.abs(output.duration - 0.75) <= 0.05, `Rendered ${output.duration} seconds`);
  execFileSync(ffmpegPath, ['-v', 'error', '-xerror', '-i', result.outputPath, '-f', 'null', '-'],
    { timeout: 15000, windowsHide: true });
});
