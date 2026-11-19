'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ffmpegPath } = require('../src/main/binaries');
const jobs = require('../src/main/jobs');
const { detectHighlights, rankHighlights } = require('../src/main/services/highlights');
const { probe } = require('../src/main/services/probe');

function samples(duration, overrides) {
  return Array.from({ length: duration * 4 }, (_, index) => {
    const time = index / 4;
    return { time, motion: 0.018, audio: 0.02, ...overrides.get(time) };
  });
}

test('ranks the strongest moment first, suppresses overlapping peaks, and retains context', () => {
  const ranked = rankHighlights(samples(23, new Map([
    [2, { motion: 0.075 }],
    [18, { motion: 0.15, audio: 0.4 }],
    [18.25, { motion: 0.12, audio: 0.18 }],
  ])), 23);

  assert.deepEqual(ranked.map(({ index, peak, start, end, duration, signal }) =>
    ({ index, peak, start, end, duration, signal })), [
    { index: 0, peak: 18, start: 14, end: 23, duration: 9, signal: 'motion-audio' },
    { index: 1, peak: 2, start: 0, end: 8, duration: 8, signal: 'motion' },
  ]);
  assert.ok(ranked[0].confidence > ranked[1].confidence);
  assert.ok(ranked[0].reason.length > 0);
});

test('suppresses steady activity and isolated whole-frame changes', () => {
  const steady = samples(10, new Map()).map((sample) => ({ ...sample, motion: 0.12, audio: 0.3 }));
  steady[20] = { ...steady[20], motion: 0.9, cut: true };
  assert.deepEqual(rankHighlights(steady, 10), []);
});

test('treats HUD-region activity as supporting evidence only', () => {
  const duration = 12;
  assert.deepEqual(rankHighlights(samples(duration, new Map([[6, { hudMotion: 0.2 }]])), duration), []);
  const [plain] = rankHighlights(samples(duration, new Map([[6, { motion: 0.085 }]])), duration);
  const [withHud] = rankHighlights(samples(duration, new Map([[6, { motion: 0.085, hudMotion: 0.2 }]])), duration);
  assert.ok(withHud.confidence > plain.confidence);
});

test('does not treat the first measured frame difference as a rise', () => {
  const steady = samples(12, new Map()).map((sample) => ({
    ...sample, motion: sample.time === 0 ? undefined : 0.12,
  }));
  assert.deepEqual(rankHighlights(steady, 12), []);
});

test('detects a strong sound on an otherwise static image', () => {
  const ranked = rankHighlights(samples(16, new Map([[8, { audio: 0.48 }]])), 16);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].signal, 'audio');
  assert.equal(ranked[0].peak, 8);
});

test('rejects an already cancelled scan before opening its source', async (t) => {
  const jobId = 'test-cancel-highlight';
  jobs.create(jobId);
  jobs.cancel(jobId);
  t.after(() => jobs.done(jobId));
  await assert.rejects(detectHighlights('missing-recording.mkv', { duration: 15 }, { jobId }),
    { name: 'CancelledError' });
});

test('finds an injected gameplay-like motion and audio burst on the selected recording track', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-highlight-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const source = path.join(workDir, 'recording.mkv');
  execFileSync(ffmpegPath, [
    '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', "color=s=160x90:r=16:d=14,drawbox=x=20:y=20:w=49:h=35:c=white:t=fill:enable='between(t,4,4.5)'",
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono:d=14',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,4,4.5),0.64*sin(2*PI*440*t),0)':s=8000:d=14",
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source,
  ], { windowsHide: true, timeout: 15000 });

  const meta = await probe(source);
  const progress = [];
  const results = await detectHighlights(source, meta, { audioTrack: 1, onProgress: (value) => progress.push(value) });
  assert.equal(results.length, 1);
  assert.equal(results[0].signal, 'motion-audio');
  assert.ok(Math.abs(results[0].peak - 4) <= 0.25, `Detected peak at ${results[0].peak}`);
  assert.ok(results[0].start <= 0.25 && results[0].end >= 9.75);
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));

  const videoOnly = await detectHighlights(source, meta, { audioTrack: 0 });
  assert.equal(videoOnly[0]?.signal, 'motion');
  const mixed = await detectHighlights(source, meta, { audioTrack: 'mix' });
  assert.equal(mixed[0]?.signal, 'motion-audio');
  const muted = await detectHighlights(source, meta, { audioTrack: 'none' });
  assert.equal(muted[0]?.signal, 'motion');

  const jobId = 'test-cancel-active-highlight';
  jobs.create(jobId);
  t.after(() => jobs.done(jobId));
  await assert.rejects(detectHighlights(source, meta, {
    jobId,
    audioTrack: 1,
    onProgress: () => jobs.cancel(jobId),
  }), { name: 'CancelledError' });
});
