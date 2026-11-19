'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { downloadRecording, linkedRecordingInputArgs, recordingLink } = require('../src/main/services/link-import');

test('recognizes individual YouTube links and strips playlist and tracking parameters', () => {
  for (const value of ['https://youtu.be/BaW_jenozKc?si=test',
    'https://www.youtube.com/watch?v=BaW_jenozKc&list=PL123',
    'https://m.youtube.com/shorts/BaW_jenozKc']) {
    const link = recordingLink(value);
    assert.equal(link.videoId, 'BaW_jenozKc');
    assert.equal(link.url.href, 'https://www.youtube.com/watch?v=BaW_jenozKc');
  }
  assert.throws(() => recordingLink('https://youtube.com/playlist?list=PL123'), /single YouTube video/);
  assert.throws(() => recordingLink('file:///C:/Users/test/video.mp4'), /HTTP/);
  assert.throws(() => recordingLink('https://user:pass@example.test/video.mp4'), /HTTP/);
  assert.equal(recordingLink('https://youtube.com.example.test/video.mp4').videoId, undefined);
});

test('streams a redirected direct link and rejects webpages and oversized files without leftovers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const media = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') return res.writeHead(302, { location: '/recording.mp4' }).end();
    if (req.url === '/webpage.mp4') return res.end('<html>Not a recording</html>');
    if (req.url === '/large') return res.end(Buffer.alloc(32));
    res.end(media);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await downloadRecording(`${base}/redirect`, { root, maxBytes: 20 });
  assert.equal(path.extname(result.filePath), '.mp4');
  assert.deepEqual(await fs.readFile(result.filePath), media);
  assert.deepEqual(linkedRecordingInputArgs(result.filePath, root),
    ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0']);
  assert.deepEqual(linkedRecordingInputArgs(path.join(root, 'ordinary.mp4'), root), []);
  await assert.rejects(downloadRecording(`${base}/webpage.mp4`, { root, maxBytes: 128 }), /direct video file/);
  await assert.rejects(downloadRecording(`${base}/large`, { root, maxBytes: 20 }), /too large/);
  assert.equal((await fs.readdir(root)).length, 1);
});

test('cancels a partial link download and removes its staging folder', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shortforge-cancel-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let reports = 0;
  const server = http.createServer((_request, response) => {
    response.write('partial video');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  await assert.rejects(downloadRecording(`http://127.0.0.1:${server.address().port}/video.mp4`, {
    root, signal: controller.signal,
    report: () => { if (++reports === 2) setImmediate(() => controller.abort()); },
  }), { name: 'AbortError' });
  assert.equal(reports, 2);
  assert.deepEqual(await fs.readdir(root), []);
});
