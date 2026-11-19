'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { ffmpegPath } = require('../src/main/binaries');
const { probe } = require('../src/main/services/probe');
const { createAutomation } = require('../src/automation/automation');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-automation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, 'input');
  const outputRoot = path.join(root, 'output');
  await fs.mkdir(inputRoot);
  await fs.mkdir(outputRoot);
  const filePath = path.join(inputRoot, 'footage.mp4');
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=15:d=2',
    '-c:v', 'libx264', filePath,
  ], { windowsHide: true, timeout: 15000 });
  return { inputRoot, outputRoot, filePath };
}

async function completed(get, jobId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = await get(jobId);
    if (['succeeded', 'failed', 'cancelled'].includes(status.state)) return status;
    await delay(25);
  }
  assert.fail('Automation job did not finish');
}

test('automation validates source and clip references and detects source changes', async (t) => {
  const config = await fixture(t);
  const automation = await createAutomation(config);
  const { jobId } = automation.analyzeVideo({ source: 'footage.mp4' });
  const analysis = await completed(automation.getJob, jobId);
  assert.equal(analysis.state, 'succeeded', JSON.stringify(analysis));
  assert.equal(analysis.result.mode, 'coverage');
  const segmentId = analysis.result.segments[0].id;
  assert.match(segmentId, /^segment-1-[a-f0-9]{12}$/);
  assert.equal(analysis.result.meta.width, 64);
  assert.ok(!JSON.stringify(analysis).includes(config.inputRoot));
  assert.throws(() => automation.renderClips({ analysisId: jobId, segmentIds: ['segment-99-0123456789ab'] }),
    { code: 'UNKNOWN_SEGMENT' });
  const rejected = automation.analyzeVideo({ source: '../footage.mp4' });
  assert.equal((await completed(automation.getJob, rejected.jobId)).error.code, 'INVALID_SOURCE');
  await fs.writeFile(path.join(config.inputRoot, 'disguised.mp4'), 'ffconcat version 1.0\nfile footage.mp4\n');
  const disguised = automation.analyzeVideo({ source: 'disguised.mp4' });
  assert.equal((await completed(automation.getJob, disguised.jobId)).state, 'failed');

  execFileSync(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
    "color=s=160x90:r=16:d=14,drawbox=x=20:y=20:w=49:h=35:c=white:t=fill:enable='between(t,4,4.5)'",
    '-c:v', 'libx264', path.join(config.inputRoot, 'gameplay.mkv'),
  ], { windowsHide: true, timeout: 15000 });
  const gameplay = automation.analyzeVideo({ source: 'gameplay.mkv', mode: 'gameplay' });
  const highlights = await completed(automation.getJob, gameplay.jobId);
  assert.equal(highlights.state, 'succeeded', JSON.stringify(highlights));
  assert.equal(highlights.result.sceneCount, null);
  assert.equal(highlights.result.segments[0].signal, 'motion');
  assert.ok(Math.abs(highlights.result.segments[0].peak - 4) <= 0.25);

  await fs.appendFile(config.filePath, 'changed');
  const render = automation.renderClips({ analysisId: jobId, segmentIds: [segmentId] });
  assert.equal((await completed(automation.getJob, render.jobId)).error.code, 'SOURCE_CHANGED');
  assert.deepEqual(await fs.readdir(config.outputRoot), []);
});

test('automation rejects a replaced render workspace and leaves its target untouched', async (t) => {
  const config = await fixture(t);
  const automation = await createAutomation(config);
  const analysis = await completed(automation.getJob,
    automation.analyzeVideo({ source: 'footage.mp4', scanMode: 'fast' }).jobId);
  const outside = path.join(path.dirname(config.outputRoot), 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  const mkdtemp = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    const created = await mkdtemp(...args);
    if (args[0] === path.join(config.outputRoot, 'shortforge-')) {
      await fs.rename(created, `${created}-original`);
      await fs.symlink(outside, created, 'junction');
    }
    return created;
  });

  const render = automation.renderClips({
    analysisId: analysis.jobId, segmentIds: [analysis.result.segments[0].id], aspectRatio: 'original',
  });
  const result = await completed(automation.getJob, render.jobId);
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'INVALID_WORKSPACE');
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
});

test('MCP stdio lists four public tools and renders selected clips to the approved folder', async (t) => {
  const config = await fixture(t);
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const packagedExe = process.env.SHORTFORGE_PACKAGED_EXE;
  const entry = packagedExe
    ? path.resolve(path.dirname(packagedExe), 'resources/app.asar/src/automation/mcp-server.js')
    : path.resolve(__dirname, '../src/automation/mcp-server.js');
  const transport = new StdioClientTransport({
    command: packagedExe ? path.resolve(packagedExe) : process.execPath,
    args: [entry],
    env: {
      ...(packagedExe ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      SHORTFORGE_INPUT_ROOT: config.inputRoot, SHORTFORGE_OUTPUT_ROOT: config.outputRoot,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'shortforge-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(),
    ['analyze_video', 'cancel_job', 'get_job', 'render_clips']);
  const rejected = await client.callTool({ name: 'analyze_video', arguments: { source: 42 } });
  assert.equal(rejected.isError, true);
  const missing = await client.callTool({
    name: 'get_job', arguments: { jobId: '6b576b42-67fe-4910-8b99-200fff930299' },
  });
  assert.deepEqual(missing.structuredContent, { error: { code: 'UNKNOWN_JOB', message: 'This job is unknown or expired.' } });
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return response.structuredContent;
  };
  const get = (jobId) => call('get_job', { jobId });
  const { jobId } = await call('analyze_video', { source: 'footage.mp4', scanMode: 'fast' });
  const analysis = await completed(get, jobId);
  assert.equal(analysis.state, 'succeeded', JSON.stringify(analysis));
  const { jobId: renderId } = await call('render_clips', {
    analysisId: jobId, segmentIds: [analysis.result.segments[0].id], aspectRatio: '9:16', outputQuality: 'balanced',
  });
  const render = await completed(get, renderId);
  assert.equal(render.state, 'succeeded', JSON.stringify(render));
  const [clip] = render.result.clips;
  assert.equal(clip.status, 'ready');
  assert.equal(path.isAbsolute(clip.artifact), false);
  assert.ok(!JSON.stringify(render).includes(config.outputRoot));
  const output = await probe(path.resolve(config.outputRoot, clip.artifact));
  assert.equal(output.videoCodec, 'h264');
  assert.equal(output.width, 1080);
  assert.equal(output.height, 1920);
  assert.ok(output.duration >= 1.9);
  assert.deepEqual(await call('cancel_job', { jobId: renderId }), { cancelled: false });
});

test('CLI shares the analysis plan and renders selected IDs in one invocation', async (t) => {
  const config = await fixture(t);
  const env = { ...process.env, SHORTFORGE_INPUT_ROOT: config.inputRoot, SHORTFORGE_OUTPUT_ROOT: config.outputRoot };
  const entry = path.resolve(__dirname, '../src/automation/cli.js');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [entry, ...args], {
    env, encoding: 'utf8', timeout: 15000, windowsHide: true,
  }));
  const analysis = run('analyze', 'footage.mp4', '--scan-mode', 'fast');
  assert.equal(analysis.state, 'succeeded');
  const segmentId = analysis.result.segments[0].id;
  const render = run('render', 'footage.mp4', '--scan-mode', 'fast', '--segments', segmentId,
    '--aspect-ratio', 'original');
  assert.equal(render.state, 'succeeded');
  assert.equal(render.result.clips[0].status, 'ready');
  assert.equal(render.result.clips[0].segmentId, segmentId);

  function assertStale(scanMode) {
    const result = spawnSync(process.execPath, [entry, 'render', 'footage.mp4', '--scan-mode', scanMode,
      '--segments', segmentId, '--aspect-ratio', 'original'], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNKNOWN_SEGMENT/);
  }
  assertStale('accurate');
  await fs.appendFile(config.filePath, 'changed');
  assertStale('fast');
  assert.equal((await fs.readdir(config.outputRoot)).length, 1);
});
