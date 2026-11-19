'use strict';

// Run with the project's Electron binary. The recording, settings, project and
// exports live in a temporary directory for the duration of the test.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { ffmpegPath } = require('../src/main/binaries');
const { registerIpc } = require('../src/main/ipc');
const { probe } = require('../src/main/services/probe');
const settings = require('../src/main/settings');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shortforge-editor-smoke-'));
const userData = path.join(workspace, 'userData');
const source = path.join(workspace, 'OBS recording.mkv');
const project = path.join(workspace, 'Gameplay clip.shortforge');
const exportsDir = path.join(workspace, 'exports');
const watchDir = path.join(workspace, 'OBS recordings');
const rendererErrors = [];
let window;
let revealedPath;

fs.mkdirSync(userData);
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

function ffmpeg(args) {
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {
    timeout: 30000, windowsHide: true,
  });
}

function runInPage(sourceCode) {
  return window.webContents.executeJavaScript(sourceCode, true);
}

async function waitFor(sourceCode, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await runInPage(sourceCode);
    if (result) return result;
    await delay(50);
  }
  const detail = await runInPage(`Array.from(document.querySelectorAll(
    '#editorStatus, #renderStatus, #exportStatus, #progMsg, .toast'
  ), el => el.textContent).filter(Boolean).join(' | ')`);
  assert.fail(`${label} timed out${detail ? ` (${detail})` : ''}`);
}

function click(selector) {
  return runInPage(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    const overlayVisible = !document.querySelector('#progressOverlay').classList.contains('hidden');
    if (!control || control.disabled || control.classList.contains('hidden') || overlayVisible) {
      throw new Error('Unavailable control ' + ${JSON.stringify(selector)});
    }
    control.click();
  })()`);
}

function setValue(selector, value, events = ['change']) {
  return runInPage(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.value = ${JSON.stringify(value)};
    for (const type of ${JSON.stringify(events)}) control.dispatchEvent(new Event(type, { bubbles: true }));
  })()`);
}

async function currentRender() {
  revealedPath = null;
  await click('.reveal-clip');
  const deadline = Date.now() + 3000;
  while (!revealedPath && Date.now() < deadline) await delay(25);
  assert.ok(revealedPath, 'Rendered file could not be revealed');
  return revealedPath;
}

async function checkRender(file, duration) {
  const meta = await probe(file);
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
  assert.equal(meta.videoCodec, 'h264');
  assert.equal(meta.audioCodec, 'aac');
  assert.ok(Math.abs(meta.duration - duration) <= 0.08, `Expected ${duration}s, got ${meta.duration}s`);
  ffmpeg(['-xerror', '-i', file, '-f', 'null', '-']);
  return meta.duration;
}

async function smokeHighlightsAndWatcher() {
  const fixture = path.join(workspace, 'Two bursts.mkv');
  const staged = path.join(watchDir, 'Ranked gameplay.mkv.part');
  const finalized = path.join(watchDir, 'Ranked gameplay.mkv');
  ffmpeg([
    '-f', 'lavfi', '-i', "color=s=160x90:r=16:d=24,drawbox=x=20:y=20:w=49:h=35:c=white:t=fill:enable='between(t,4,4.5)',drawbox=x=75:y=20:w=49:h=35:c=white:t=fill:enable='between(t,18,18.5)'",
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono:d=24',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,18,18.5),0.64*sin(2*PI*440*t),0)':s=8000:d=24",
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'pcm_s16le',
    '-metadata:s:a:0', 'title=Game audio', '-metadata:s:a:1', 'title=Highlight signal', fixture,
  ]);
  fs.mkdirSync(watchDir);
  fs.copyFileSync(fixture, path.join(watchDir, 'Already present.mkv'));
  await click('#watchRecordingsBtn');
  await waitFor('document.querySelector("#watchStatus").textContent.startsWith("Watching ")', 'Start watching');
  fs.copyFileSync(fixture, staged);
  const finalizingAt = performance.now();
  fs.renameSync(staged, finalized);
  await waitFor(`document.querySelector('#watchStatus').textContent === 'Ranked gameplay.mkv is ready to import.'`,
    'Stable recording alert');
  assert.ok(performance.now() - finalizingAt >= 10000, 'The recording appeared before the default quiet period');
  assert.equal(await runInPage('document.querySelector("#fileName").textContent'), 'OBS recording.mkv');
  assert.equal(await runInPage('document.querySelectorAll("#availableRecordings button").length'), 1);
  await click('#availableRecordings button[aria-label="Import Ranked gameplay.mkv"]');
  await waitFor('document.querySelector("#fileName").textContent === "Ranked gameplay.mkv"', 'Explicit watched recording import');

  fs.copyFileSync(fixture, path.join(watchDir, 'Do not report.mkv'));
  await click('#stopWatchingBtn');
  await waitFor('document.querySelector("#watchStatus").textContent === "Stopped watching for new recordings."', 'Stop watching');
  fs.copyFileSync(fixture, path.join(watchDir, 'After stop.mkv'));
  const stoppedAt = Date.now();

  await setValue('#clipMode', 'gameplay');
  await setValue('#audioTrack', '1');
  await setValue('#targetLen', '3');
  await setValue('#editorSeek', '11.5', ['input']);
  await click('#editorMark');
  await waitFor('Boolean(document.querySelector("#clipGrid [data-clip]"))', 'Manual marker on watched recording');

  await click('#analyzeBtn');
  await waitFor('document.querySelector("#summary").textContent.includes("2 suggestions added")', 'Find two local highlights');
  const reasons = await runInPage('Array.from(document.querySelectorAll("#clipGrid .clip-reason"), el => el.textContent)');
  assert.match(reasons[0], /Marked at/);
  assert.match(reasons[1], /Motion and sound increased together/);
  assert.match(reasons[2], /Motion increased above the recent baseline/);
  assert.equal(reasons.length, 3);

  await click('#analyzeBtn');
  await waitFor('document.querySelector("#summary").textContent.includes("Suggestions overlapped your existing clips")',
    'Repeat scan deduplicates against existing clips');
  assert.deepEqual(await runInPage('Array.from(document.querySelectorAll("#clipGrid .clip-reason"), el => el.textContent)'), reasons);

  // Allow the queued file enough time to have passed the real watch period.
  await delay(Math.max(0, 11500 - (Date.now() - stoppedAt)));
  assert.equal(await runInPage('document.querySelector("#watchStatus").textContent'), 'Stopped watching for new recordings.');
  assert.equal(await runInPage('document.querySelectorAll("#availableRecordings button").length'), 1);
  console.log('Gameplay smoke passed: ranked two real highlights, kept the manual marker, deduplicated a repeat scan, and imported only after opting in.');
}

async function smoke() {
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac',
    '-metadata:s:a:0', 'title=Game audio', '-metadata:s:a:1', 'title=Mic audio', source,
  ]);
  settings.save({ hwAccel: 'cpu', aiEnabled: false, _fsMigration: true });
  dialog.showOpenDialog = async (_window, options) => {
    if (options.properties.includes('openDirectory')) {
      const dir = options.properties.includes('createDirectory') ? exportsDir : watchDir;
      return { canceled: false, filePaths: [dir] };
    }
    if (options.filters?.some((filter) => filter.extensions.includes('shortforge'))) {
      return { canceled: false, filePaths: [project] };
    }
    return { canceled: false, filePaths: [source] };
  };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: project });
  shell.openPath = async () => '';
  shell.showItemInFolder = (file) => { revealedPath = file; };

  registerIpc(() => window);
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, '../src/main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      partition: 'editor-smoke',
      offscreen: Boolean(process.env.SHORTFORGE_SMOKE_SCREENSHOT),
    },
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) rendererErrors.push(message);
  });
  await window.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await waitFor('document.querySelector("#aspectRatio").options.length', 'Renderer settings');
  await click('#addVideoBtn');
  await waitFor('document.querySelector("#fileName").textContent === "OBS recording.mkv"', 'Recording import');
  assert.match(await runInPage('document.querySelectorAll("#audioTrack option")[1].textContent'), /Mic audio/);
  await setValue('#clipMode', 'gameplay');
  await setValue('#audioTrack', '1');
  await click('#presetHudSafe');
  await setValue('#outputQuality', 'balanced');
  await setValue('#targetLen', '3');
  await setValue('#editorSeek', '2.7', ['input']);
  await click('#editorMark');
  await waitFor('document.querySelector("#editorTitle").textContent === "Edit clip 1"', 'Gameplay marker editor');
  await setValue('#editorIn', '1.1', ['input', 'change']);
  await setValue('#editorOut', '3.6', ['input', 'change']);
  assert.match(await runInPage('document.querySelector("#editorValidation").textContent'), /2\.50 seconds/);

  await click('#editorProxy');
  await waitFor(`document.querySelector('#editorStatus').textContent.includes('Preview available')
    && document.querySelector('#editorVideo').readyState >= 1`, 'Selected-audio playback preview');
  const previewDuration = await runInPage('document.querySelector("#editorVideo").duration');
  assert.ok(Math.abs(previewDuration - 2.5) <= 0.08, `Expected a 2.5s preview, got ${previewDuration}s`);

  await click('#editorRender');
  await waitFor('document.querySelector("#renderStatus").textContent.includes("1/1 shorts rendered")', 'Clip render');
  const first = await currentRender();
  const firstDuration = await checkRender(first, 2.5);

  await setValue('#editorOut', '2.4', ['input', 'change']);
  assert.match(await runInPage('document.querySelector("#editorValidation").textContent'), /1\.30 seconds/);
  await click('#editorPlayRender');
  await waitFor('document.querySelector("#editorSeek").max === "3.6"', 'Previous render keeps its original out point');
  await click('#editorRender');
  await waitFor(`!document.querySelector('#downloadBtn').disabled
    && !document.querySelector('#downloadBtn').classList.contains('hidden')`, 'Clip rerender');
  const second = await currentRender();
  assert.notEqual(first, second);
  assert.ok(fs.existsSync(first), 'Rerender removed the first playable output');
  const secondDuration = await checkRender(second, 1.3);

  await click('#downloadBtn');
  await waitFor('document.querySelector("#exportStatus").textContent.includes("1/1 shorts exported")', 'Batch export');
  const files = fs.readdirSync(exportsDir);
  assert.deepEqual(files, [path.basename(second)]);
  await checkRender(path.join(exportsDir, files[0]), 1.3);

  await click('#saveProjectBtn');
  await waitFor('Array.from(document.querySelectorAll(".toast")).some(el => el.textContent === "Project saved")', 'Project save');
  assert.ok(fs.existsSync(project));
  await setValue('#clipMode', 'coverage');
  await click('#openProjectBtn');
  await waitFor('Array.from(document.querySelectorAll(".toast")).some(el => el.textContent === "Project opened")', 'Project reopen');
  assert.equal(await runInPage('document.querySelector("#clipMode").value'), 'gameplay');
  assert.equal(await runInPage('document.querySelector("#audioTrack").value'), '1');
  assert.equal(await runInPage('document.querySelector("#aspectRatio").value'), '9:16');
  await click('.review-clip');
  assert.equal(await runInPage('document.querySelector("#editorIn").value'), '1.1');
  assert.equal(await runInPage('document.querySelector("#editorOut").value'), '2.4');
  assert.equal(await currentRender(), second);

  await click('#aiToggle');
  await waitFor('document.querySelector("#downloadBtn").disabled', 'AI output setting invalidates the prior render');
  await click('#aiToggle');

  if (process.env.SHORTFORGE_SMOKE_SCREENSHOT) {
    await click('#editorPlayRender');
    await waitFor(`document.querySelector('#editorVideo').videoWidth === 1080
      && document.querySelector('#editorVideo').currentTime > 0.05`, 'Reopened render playback');
    await runInPage(`document.querySelector('#editorVideo').pause();
      document.querySelector('#editorSafeZone').click();`);
    const image = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Editor screenshot did not paint')), 5000);
      window.webContents.once('paint', (_event, _dirty, frame) => {
        clearTimeout(deadline);
        resolve(frame);
      });
      window.webContents.invalidate();
    });
    assert.ok(!image.isEmpty(), 'Editor screenshot was empty');
    fs.writeFileSync(process.env.SHORTFORGE_SMOKE_SCREENSHOT, image.toPNG());
  }
  console.log(`Editor smoke passed: OBS import, playback preview, ${firstDuration}s and ${secondDuration}s vertical renders, export, project reopen.`);
  await smokeHighlightsAndWatcher();
  await smokeEnrichmentConsent();
}

async function smokeEnrichmentConsent() {
  settings.setApiKey('test-only-openrouter-key');
  const requests = [];
  const dialogs = [];
  const fetch = global.fetch;
  const messageBox = dialog.showMessageBox;
  let response = 1;
  try {
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: {
        content: JSON.stringify({ title: 'Fixture highlight', eventType: 'other' }),
      } }] }) };
    };
    dialog.showMessageBox = async (_window, options) => {
      dialogs.push(options.detail);
      return { response };
    };
    const request = {
      filePath: source, segments: [{ index: 0, start: 0, end: 3, duration: 3 }],
      settings: { analysisMode: 'gameplay', aiModelVision: 'fixture', shareTranscriptContext: false },
    };
    const enrich = (jobId) => runInPage(`window.api.enrich(${JSON.stringify({ ...request, jobId })})`);
    assert.equal((await enrich('smoke-consent-declined')).cancelled, true);
    assert.equal(requests.length, 0);
    response = 0;
    assert.equal((await enrich('smoke-consent-approved')).segments[0].title, 'Fixture highlight');
    assert.match(dialogs[1], /up to three still frames/);
    assert.equal(requests.length, 1);
    const content = requests[0].messages[1].content;
    assert.equal(content.filter((item) => item.type === 'image_url').length, 3);
    assert.doesNotMatch(content[0].text, /Transcript:/);
    console.log('Enrichment smoke passed: approval required, three stills sent to the mock, transcript excluded by default.');
  } finally {
    global.fetch = fetch;
    dialog.showMessageBox = messageBox;
    settings.setApiKey('');
  }
}

function cleanAfterExit() {
  // Chromium holds its LevelDB and GPU cache handles until Electron exits.
  const cleanup = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = path.resolve(process.argv[1]);
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) ||
        !path.basename(dir).startsWith('shortforge-editor-smoke-')) process.exit(1);
    fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }, err => {
      if (err) process.exitCode = 1;
    });
  `, workspace], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  cleanup.unref();
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await smoke();
  } catch (err) {
    console.error(err);
    for (const message of rendererErrors) console.error(`Renderer: ${message}`);
    exitCode = 1;
  } finally {
    window?.destroy();
    cleanAfterExit();
    app.exit(exitCode);
  }
});
