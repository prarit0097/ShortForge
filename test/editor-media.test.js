'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ffmpegPath } = require('../src/main/binaries');
const { cutClip } = require('../src/main/services/cutter');
const { probe } = require('../src/main/services/probe');
const { detectKeyframes } = require('../src/main/services/scenes');

const run = (args) => execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args],
  { timeout: 15000, windowsHide: true });

function toneAmplitude(pcm, frequency) {
  let real = 0;
  let imag = 0;
  for (let i = 0; i < pcm.length / 2; i++) {
    const point = pcm.readInt16LE(i * 2);
    const phase = 2 * Math.PI * frequency * i / 8000;
    real += point * Math.cos(phase);
    imag += point * Math.sin(phase);
  }
  return Math.hypot(real, imag) / (pcm.length / 2);
}

test('lists named OBS tracks and renders selected, mixed, and muted audio', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-tracks-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'session.mkv');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.5',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac',
    '-metadata:s:a:0', 'title=Game', '-metadata:s:a:1', 'title=Mic', source]);
  const meta = await probe(source);
  assert.deepEqual(meta.audioTracks.map(({ index, title }) => [index, title]), [[0, 'Game'], [1, 'Mic']]);

  for (const audioTrack of [1, 'mix', 'none']) {
    const target = path.join(dir, `${audioTrack}.mp4`);
    await cutClip(source, { index: 0, start: 0.2, end: 1.2, duration: 1 }, target, {
      hwAccel: 'cpu', ratioKey: 'original', quality: 'balanced', hasAudio: true,
      audioTrack, audioTracks: meta.audioTracks, videoStreamIndex: meta.videoStreamIndex,
    });
    if (audioTrack === 'none') {
      assert.equal((await probe(target)).hasAudio, false);
      continue;
    }
    const pcm = run(['-i', target, '-vn', '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1']);
    const game = toneAmplitude(pcm, 440);
    const mic = toneAmplitude(pcm, 880);
    assert.ok(mic > 300, `mic amplitude was ${mic}`);
    assert.ok(audioTrack === 'mix' ? game > 300 : game < mic / 8, `game amplitude was ${game}`);
  }
});

test('normalizes keyframes to the start of a timestamped MPEG-TS source', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-timestamps-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'recording.ts');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3', '-c:v', 'libx264',
    '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-f', 'mpegts', source]);
  const meta = await probe(source);
  assert.ok(meta.startTime > 1);
  const cuts = await detectKeyframes(source, { videoStreamIndex: meta.videoStreamIndex, startTime: meta.startTime });
  assert.equal(cuts.length, 3);
  for (const [index, seconds] of cuts.entries()) assert.ok(Math.abs(seconds - index) < 0.05, `${cuts}`);
});

test('keeps display orientation when rendering a silent rotated variable-rate MOV', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-rotation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const landscape = path.join(dir, 'landscape.mov');
  const portrait = path.join(dir, 'portrait.mov');
  const rendered = path.join(dir, 'rendered.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1.5',
    '-vf', "select='not(mod(n,3))+not(mod(n,5))'", '-fps_mode', 'vfr', '-c:v', 'libx264', landscape]);
  run(['-display_rotation', '90', '-i', landscape, '-c', 'copy', portrait]);
  const meta = await probe(portrait);
  assert.equal(meta.width, 90);
  assert.equal(meta.height, 160);
  assert.ok(meta.fps > 1 && meta.fps < 30);
  await cutClip(portrait, { index: 0, start: 0.1, end: 1.1, duration: 1 }, rendered, {
    hwAccel: 'cpu', ratioKey: 'original', quality: 'balanced', hasAudio: false, videoStreamIndex: meta.videoStreamIndex,
  });
  const output = await probe(rendered);
  assert.equal(output.width, 90);
  assert.equal(output.height, 160);
  assert.equal(output.hasAudio, false);
  run(['-xerror', '-i', rendered, '-f', 'null', '-']);
});
