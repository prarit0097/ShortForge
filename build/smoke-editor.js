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
    if (options.properties.includes('openDirectory')) return { canceled: false, filePaths: [exportsDir] };
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
