'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ffmpegPath } = require('../binaries');
const jobs = require('../jobs');
const { localMediaInputArgs } = require('../../automation/local-media');

const MAX_BYTES = 10 * 1024 ** 3;
const YT_VERSION = '2026.10.26';
const YT_HASH = 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d';
const DEMUXERS = { mp4: 'mov', mkv: 'matroska', avi: 'avi', flv: 'flv', ts: 'mpegts' };

function linkedRecordingInputArgs(filePath, root) {
  if (typeof filePath !== 'string') return [];
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  const match = /^recording-[a-z0-9]+\/source\.(mp4|mkv|avi|flv|ts)$/i.exec(relative);
  return match ? localMediaInputArgs(DEMUXERS[match[1].toLowerCase()]) : [];
}

function httpUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { /* handled below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Paste an HTTP or HTTPS video link without embedded credentials.');
  }
  url.hash = '';
  return url;
}

function recordingLink(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Paste a valid video link.');
  const url = httpUrl(value.trim());
  const host = url.hostname.toLowerCase();
  if (host !== 'youtu.be' && host !== 'youtube.com' && !host.endsWith('.youtube.com')) return { url };
  const parts = url.pathname.split('/');
  const videoId = host === 'youtu.be' ? parts[1]
    : parts[1] === 'watch' ? url.searchParams.get('v')
      : ['shorts', 'live', 'embed'].includes(parts[1]) ? parts[2] : null;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw new Error('Paste a link to a single YouTube video.');
  return { url: new URL(`https://www.youtube.com/watch?v=${videoId}`), videoId };
}

async function download(url, destination, { signal, maxBytes, report = () => {} }) {
  let response;
  for (let i = 0; i <= 5; i++) {
    try {
      response = await fetch(url, { signal, redirect: 'manual' });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Could not connect to the download server. Check the link and your connection.');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || i === 5) throw new Error('The download link redirected too many times.');
    url = httpUrl(location, url);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`The download server returned HTTP ${response.status}.`);
  }
  const expected = Number(response.headers.get('content-length'));
  if (expected > maxBytes) {
    await response.body.cancel();
    throw new Error('The download is too large.');
  }
  let received = 0;
  let last = -1;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error('The download is too large.'));
      const percent = expected ? Math.min(99, Math.floor(received / expected * 100)) : 0;
      if (percent !== last) report(percent, 'Downloading video…');
      last = percent;
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(destination, { flags: 'wx' }), { signal });
  return url;
}

async function mediaExtension(filePath) {
  const file = await fs.open(filePath, 'r');
  const head = Buffer.alloc(576);
  try { await file.read(head); } finally { await file.close(); }
  if (['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(head.toString('ascii', 4, 8))) return 'mp4';
  if (head.readUInt32BE(0) === 0x1a45dfa3) return 'mkv';
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'AVI ') return 'avi';
  if (head.toString('ascii', 0, 3) === 'FLV') return 'flv';
  if ([0, 188, 376].every((index) => head[index] === 0x47)) return 'ts';
  throw new Error('This link did not return a supported direct video file. Use MP4, MOV, MKV, WebM, AVI, FLV, or TS.');
}

async function validDownloader(exe) {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(exe)) hash.update(chunk);
    return hash.digest('hex') === YT_HASH;
  } catch { return false; }
}

async function youtubeDownloader(root, signal) {
  const exe = path.join(root, `yt-dlp-${YT_VERSION}.exe`);
  if (await validDownloader(exe)) return exe;
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, 'setup-'));
  try {
    const staged = path.join(folder, 'yt-dlp.exe');
    await download(new URL(`https://github.com/yt-dlp/yt-dlp/releases/download/${YT_VERSION}/yt-dlp.exe`), staged,
      { signal, maxBytes: 32 * 1024 ** 2 });
    if (!await validDownloader(staged)) throw new Error('YouTube downloader verification failed.');
    try { await fs.rename(staged, exe); } catch (error) { if (!await validDownloader(exe)) throw error; }
    return exe;
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

async function downloadYouTube(link, folder, { toolsDir, signal, report, maxBytes }) {
  let runtime;
  try {
    runtime = path.join(path.dirname(require.resolve('@deno/win32-x64/package.json')), 'deno.exe')
      .replace(/([\\/])app\.asar(?=[\\/])/i, '$1app.asar.unpacked');
    await fs.access(runtime);
  } catch { throw new Error('YouTube import needs the Windows x64 ShortForge package with Deno installed.'); }
  signal?.throwIfAborted();
  report(0, 'Preparing YouTube downloader…');
  const exe = await youtubeDownloader(toolsDir, signal);
  signal?.throwIfAborted();
  report(0, 'Downloading from YouTube…');
  await new Promise((resolve, reject) => {
    const proc = spawn(exe, ['--ignore-config', '--no-playlist', '--no-plugin-dirs', '--no-cache-dir',
      '--no-remote-components', '--no-js-runtimes', '--js-runtimes', `deno:${runtime}`,
      '--no-live-from-start', '--match-filter', '!is_live', '--no-simulate',
      '--socket-timeout', '20', '--newline', '--progress', '--no-mtime', '--max-filesize', String(maxBytes),
      '--ffmpeg-location', ffmpegPath, '--merge-output-format', 'mp4',
      '-f', 'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/b[height<=1080]',
      '-o', 'recording.%(ext)s', '--', link.url.href],
    { cwd: folder, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cancel = () => {
      if (!proc.pid || proc.exitCode !== null) return;
      // yt-dlp can have an active FFmpeg merge or manifest request subprocess.
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => proc.kill());
      killer.once('close', (code) => { if (code !== 0 && proc.exitCode === null) proc.kill(); });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    let stderr = '';
    let last = -1;
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    proc.stdout.on('data', (chunk) => {
      for (const match of chunk.toString().matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)) {
        const percent = Math.floor(Number(match[1]));
        if (percent !== last) report(percent, 'Downloading from YouTube…');
        last = percent;
      }
    });
    proc.once('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(error);
    });
    proc.once('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) return reject(new jobs.CancelledError());
      if (code === 0) return resolve();
      const detail = stderr.split(/\r?\n/).findLast((line) => line.startsWith('ERROR:'));
      reject(new Error(detail ? `YouTube download failed. ${detail.slice(6).trim()}` : 'YouTube download failed.'));
    });
  });
  const file = (await fs.readdir(folder)).find((name) => /^recording\.(mp4|webm|mkv)$/.test(name));
  if (!file) throw new Error('YouTube did not return a finished recording. Check that it is a public video within the download limits.');
  return path.join(folder, file);
}

async function downloadRecording(value, { root, toolsDir = path.join(root, 'tools'),
  signal, report = () => {}, maxBytes = MAX_BYTES }) {
  const link = recordingLink(value);
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, 'recording-'));
  try {
    let source = path.join(folder, 'download');
    let label;
    if (link.videoId) {
      source = await downloadYouTube(link, folder, { toolsDir, signal, report, maxBytes });
      label = `YouTube ${link.videoId}`;
    } else {
      report(0, 'Downloading video…');
      const finishedUrl = await download(link.url, source, { signal, maxBytes, report });
      label = path.posix.basename(finishedUrl.pathname) || 'Linked recording';
      try { label = decodeURIComponent(label); } catch { /* retain encoded label */ }
    }
    signal?.throwIfAborted();
    if ((await fs.stat(source)).size > maxBytes) throw new Error('The download is too large.');
    const ext = await mediaExtension(source);
    const filePath = path.join(folder, `source.${ext}`);
    await fs.rename(source, filePath);
    report(100, 'Recording downloaded.');
    return { filePath, label, folder, inputArgs: linkedRecordingInputArgs(filePath, root) };
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { downloadRecording, linkedRecordingInputArgs, recordingLink };
