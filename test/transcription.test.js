'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeClipSrt } = require('../src/main/services/transcribe');

test('caption times are relative to the clip and stop at its out point', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortforge-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srt = path.join(dir, 'clip.srt');
  writeClipSrt([{ start: 7, end: 15, text: 'Game commentary' }], 10, 11.5, srt);
  assert.match(fs.readFileSync(srt, 'utf8'), /00:00:00,000 --> 00:00:01,500\nGame commentary/);
});
