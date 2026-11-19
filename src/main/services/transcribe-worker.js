'use strict';

// A separate process lets Cancel stop native inference and model downloads.
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { nodewhisper, disposeWhisper } = require('nodejs-whisper');
const downloadModel = require('nodejs-whisper/dist/autoDownloadModel').default;
const { MODEL_OBJECT, LEGACY_MODEL_FILES, isModelName } = require('nodejs-whisper/dist/constants');
const { isGgmlModel } = require('nodejs-whisper/dist/download');

function readSegments(output) {
  const toSeconds = (value) => value.replace(',', '.').split(':').map(Number)
    .reduce((sum, part) => sum * 60 + part, 0);
  return [...output.matchAll(/^\s*\[([\d:.,]+) --> ([\d:.,]+)\][ \t]*(.*)$/gm)]
    .map(([, start, end, text]) => ({ start: toSeconds(start), end: toSeconds(end), text: text.trim() }))
    .filter(({ start, end, text }) => Number.isFinite(start) && Number.isFinite(end) && end > start && text);
}

async function prepareModel({ model, modelRootPath, scratch }, report) {
  if (!isModelName(model)) throw new Error('Invalid Whisper model.');
  const names = [MODEL_OBJECT[model], ...(LEGACY_MODEL_FILES[model] || [])];
  const saved = names.map((name) => path.join(modelRootPath, name)).find((file) => fs.existsSync(file));
  if (saved) {
    if (!isGgmlModel(saved)) throw new Error('Existing Whisper model is invalid.');
    return;
  }
  report('model');
  // Download into the job directory so killing the worker cannot leave a partial model behind.
  await downloadModel({ debug() {} }, model, false, scratch);
  const destination = path.join(modelRootPath, names[0]);
  try {
    fs.renameSync(path.join(scratch, names[0]), destination);
  } catch (error) {
    if (!isGgmlModel(destination)) throw error;
  }
}

async function transcribeRanges(request) {
  const { ranges, model, modelRootPath, scratch, backend } = request;
  const total = ranges.reduce((sum, { start, end }) => sum + (end - start), 0);
  const segments = [];
  const wav = path.join(scratch, 'audio.wav');
  let completed = 0;
  let processed = 0;
  const report = (phase, seen = processed, done = completed) => {
    process.send({ progress: { phase, processed: seen, total, completed: done, count: ranges.length } });
  };
  await prepareModel(request, report);
  for (const range of ranges) {
    const duration = range.end - range.start;
    report('extracting');
    const extraction = once(process, 'message');
    process.send({ extract: range });
    const [{ error }] = await extraction;
    if (error) throw new Error(error);
    let heard = 0;
    const logger = {
      debug(message) {
        if (/Transcribing with native backend|Executing command:/.test(message)) report('transcribing');
      },
      info(message) {
        for (const { end } of readSegments(message)) heard = Math.max(heard, end);
        if (heard > 0 && heard < duration) report('transcribing', processed + heard);
      },
      error() {},
    };
    try {
      const output = await nodewhisper(wav, { modelName: model, modelRootPath, backend, logger });
      for (const line of readSegments(output)) {
        const start = range.start + line.start;
        const end = Math.min(range.end, range.start + line.end);
        if (end > start) segments.push({ start, end, text: line.text });
      }
    } catch (error) {
      if (!String(error.message).includes('Transcription failed or produced no output.')) throw error;
    }
    completed += 1;
    processed = completed === ranges.length ? total : processed + duration;
    report('processed');
  }
  return segments;
}

process.once('message', async (request) => {
  let result;
  try {
    result = { available: true, segments: await transcribeRanges(request) };
  } catch (error) {
    result = { available: true, segments: [], error: error.message };
  } finally {
    await disposeWhisper().catch(() => {});
    if (process.connected) process.send(result, () => process.disconnect());
  }
});
