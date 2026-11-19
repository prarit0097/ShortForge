'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { saveProject, openProject } = require('../src/main/services/projects');

test('round-trips trims and verified cached renders while excluding secrets', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-project-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const cacheRoot = path.join(dir, 'cache');
  await fs.mkdir(cacheRoot);
  const sourcePath = path.join(dir, 'session.mkv');
  const outputPath = path.join(cacheRoot, '001.mp4');
  const projectPath = path.join(dir, 'session.shortforge');
  await fs.writeFile(sourcePath, 'recording');
  await fs.writeFile(outputPath, 'render cache');

  const draft = {
    sourcePath, mode: 'gameplay',
    settings: { aspectRatio: '9:16', reframeMode: 'blur', audioTrack: 'mix', apiKey: 'secret' },
    segments: [{ index: 0, start: 3, end: 12, peak: 7.214, title: 'Road trip', cropBias: -0.5,
      selected: true, outputPath, transcript: 'private speech' }],
  };
  await saveProject(projectPath, draft, { cacheRoot });
  const raw = await fs.readFile(projectPath, 'utf8');
  assert.doesNotMatch(raw, /secret|private speech/);

  const saved = await openProject(projectPath, { cacheRoot });
  assert.equal(saved.sourcePath, sourcePath);
  assert.equal(saved.settings.audioTrack, 'mix');
  assert.equal(saved.segments[0].duration, 9);
  assert.equal(saved.segments[0].cropBias, -0.5);
  assert.equal(saved.segments[0].peak, 7.214);
  assert.equal(saved.segments[0].outputPath, outputPath);

  await fs.appendFile(sourcePath, ' changed');
  const changed = await openProject(projectPath, { cacheRoot });
  assert.equal(changed.sourceChanged, true);
  assert.equal(changed.segments[0].outputPath, undefined);
});

test('validates project content and confines render paths to the cache', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-project-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cacheRoot = path.join(dir, 'cache');
  await fs.mkdir(cacheRoot);
  const sourcePath = path.join(dir, 'recording.mp4');
  const outside = path.join(dir, 'outside.mp4');
  const projectPath = path.join(dir, 'edit.shortforge');
  await fs.writeFile(sourcePath, 'source');
  await fs.writeFile(outside, 'outside');

  const draft = { sourcePath, segments: [{ index: 0, start: 0, end: 1, outputPath: outside }] };
  await saveProject(projectPath, draft, { cacheRoot });
  assert.equal((await openProject(projectPath, { cacheRoot })).segments[0].outputPath, undefined);
  const data = JSON.parse(await fs.readFile(projectPath, 'utf8'));
  data.segments[0].output = '../outside.mp4';
  await fs.writeFile(projectPath, JSON.stringify(data));
  assert.equal((await openProject(projectPath, { cacheRoot })).segments[0].outputPath, undefined);
  data.segments[0].end = -1;
  await fs.writeFile(projectPath, JSON.stringify(data));
  await assert.rejects(openProject(projectPath, { cacheRoot }), /clip range/i);
});
