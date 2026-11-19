'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { ffmpegPath } = require('../src/main/binaries');
const jobs = require('../src/main/jobs');
const { selectedAudioRanges, transcribe, writeClipSrt } = require('../src/main/services/transcribe');

test('selected audio deduplicates overlap and preserves gaps and adjacent clips', () => {
  const clips = [{ start: 20, end: 25 }, { start: 5, end: 10 },
    { start: 0, end: 3 }, { start: 1, end: 5 }, { start: 21, end: 24 }];
  assert.deepEqual(selectedAudioRanges(clips), [
    { start: 0, end: 5 }, { start: 5, end: 10 }, { start: 20, end: 25 },
  ]);
  assert.throws(() => selectedAudioRanges([{ start: -1, end: 10 }]), /range/i);
});

const speech = process.env.SHORTFORGE_TEST_WHISPER_SPEECH;
const models = process.env.SHORTFORGE_TEST_WHISPER_MODELS;
const nativeOptions = { skip: !speech || !models, timeout: 60000 };

test('native Whisper transcribes selected ranges with source timestamps and measured progress', nativeOptions, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortforge-selected-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recording = path.join(dir, 'gaps.wav');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', speech,
    '-af', 'aresample=16000,apad=whole_dur=8,aloop=loop=3:size=128000,atrim=end=32', recording]);
  const updates = [];
  const ranges = [{ start: 8, end: 16 }, { start: 24, end: 32 }];
  const result = await transcribe(recording, {
    model: 'tiny.en', modelRootPath: models, ranges, onProgress: (update) => updates.push(update),
  });
  assert.equal(result.error, undefined);
  for (const { start, end } of ranges) assert.ok(result.segments.some((line) => line.start >= start && line.end <= end));
  assert.ok(result.segments.every((line) => ranges.some(({ start, end }) => line.start >= start && line.end <= end)));
  assert.ok(updates.some(({ phase, processed, completed }) =>
    phase === 'transcribing' && processed > 0 && completed === 0));
  assert.ok(updates.every(({ total }) => total === 16));
  assert.equal(updates.at(-1).processed, 16);
});

test('cancel interrupts an active native Whisper inference and leaves the next job usable', nativeOptions, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortforge-whisper-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recording = path.join(dir, 'long.wav');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', speech,
    '-af', 'aresample=16000,apad=whole_dur=8,aloop=loop=4:size=128000,atrim=end=40', recording]);
  const jobId = 'cancel-whisper-inference';
  jobs.create(jobId);
  let cancelledAt;
  try {
    await assert.rejects(transcribe(recording, {
      jobId, model: 'tiny.en', modelRootPath: models, ranges: [{ start: 0, end: 40 }],
      onProgress({ phase, processed, completed }) {
        if (phase === 'transcribing' && processed > 0 && completed === 0 && !cancelledAt) {
          cancelledAt = performance.now();
          jobs.cancel(jobId);
        }
      },
    }), { name: 'CancelledError' });
    assert.ok(cancelledAt && performance.now() - cancelledAt < 2000);
    const next = await transcribe(speech, { model: 'tiny.en', modelRootPath: models, ranges: [{ start: 0, end: 5 }] });
    assert.ok(next.segments.length);
  } finally {
    jobs.done(jobId);
  }
});

test('caption times are relative to the clip and stop at its out point', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortforge-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srt = path.join(dir, 'clip.srt');
  writeClipSrt([{ start: 7, end: 15, text: 'Game commentary' }], 10, 11.5, srt);
  assert.match(fs.readFileSync(srt, 'utf8'), /00:00:00,000 --> 00:00:01,500\nGame commentary/);
});
