'use strict';

const { spawn } = require('node:child_process');
const { ffmpegPath } = require('../binaries');
const jobs = require('../jobs');

const SAMPLE_RATE = 4;
const AUDIO_HZ = 8000;
const FRAME_WIDTH = 80;
const FRAME_HEIGHT = 46;
const MAX_HIGHLIGHTS = 20;
const REASONS = {
  motion: 'Motion increased above the recent baseline',
  audio: 'Sound level rose abruptly above the recent baseline',
  'motion-audio': 'Motion and sound increased together',
};

function createRanker(duration) {
  const ranked = [];
  let motionBaseline;
  let audioBaseline;
  let hudBaseline = 0;

  return {
    add({ time, motion, audio, hudMotion = 0, cut }) {
      if (time >= duration) return;
      let motionRise = 0;
      if (motion !== undefined && !cut) {
        motionBaseline ??= motion;
        motionRise = Math.max(0, motion - Math.max(0.008, motionBaseline * 1.32));
        motionBaseline += 0.12 * (motion - motionBaseline);
      }
      audioBaseline ??= audio;
      const audioRise = Math.max(0, audio - Math.max(0.018, audioBaseline * 1.55));
      audioBaseline += 0.12 * (audio - audioBaseline);

      const visual = Math.min(1, motionRise / 0.105);
      const sound = Math.min(1, audioRise / 0.19);
      const activity = 0.58 * visual + 0.32 * sound + 0.10 * Math.min(visual, sound);
      const edgeRise = cut ? 0 : Math.max(0, hudMotion - Math.max(0.025, hudBaseline * 1.5));
      if (!cut) hudBaseline += 0.12 * (hudMotion - hudBaseline);
      if (activity < 0.22) return;
      const score = Math.min(1, activity + Math.min(0.07, edgeRise * 0.25));

      const signal = visual >= 0.18 && sound >= 0.25 ? 'motion-audio' : visual >= 0.18 ? 'motion' : 'audio';
      const start = Math.max(0, time - 4);
      const end = Math.min(duration, time + 6);
      const overlaps = (item) => start < item.end && end > item.start;
      if (ranked.some((item) => overlaps(item) && item.score >= score)) return;
      for (let i = ranked.length - 1; i >= 0; i--) {
        if (overlaps(ranked[i])) ranked.splice(i, 1);
      }
      const reason = REASONS[signal] + (edgeRise >= 0.08 ? ' with a change near the HUD area' : '');
      ranked.push({ start, end, duration: end - start, peak: time, score, signal, reason });
      ranked.sort((a, b) => b.score - a.score || a.peak - b.peak);
      if (ranked.length > MAX_HIGHLIGHTS) ranked.pop();
    },
    results() {
      return ranked.map(({ score, ...clip }, index) => ({ index, ...clip, confidence: Math.round(score * 100) }));
    },
  };
}

function rankHighlights(samples, duration) {
  const ranker = createRanker(duration);
  for (const sample of samples) ranker.add(sample);
  return ranker.results();
}

// Keep at most one incomplete record while FFmpeg fills each raw output pipe.
async function* blocks(stream, size, includePartial = false) {
  let block = Buffer.allocUnsafe(size);
  let filled = 0;
  for await (const chunk of stream) {
    let offset = 0;
    while (offset < chunk.length) {
      const copied = chunk.copy(block, filled, offset, offset + size - filled);
      offset += copied;
      filled += copied;
      if (filled === size) {
        yield block;
        block = Buffer.allocUnsafe(size);
        filled = 0;
      }
    }
  }
  if (includePartial && filled > 0) yield block.subarray(0, filled);
}

function frameMotion(frame, previous) {
  if (!frame || !previous) return {};
  let difference = 0;
  let changedPixels = 0;
  let edgeDifference = 0;
  let edgePixels = 0;
  for (let i = 0; i < frame.length; i++) {
    const delta = Math.abs(frame[i] - previous[i]);
    difference += delta;
    if (delta > 36) changedPixels++;
    const x = i % FRAME_WIDTH;
    if ((i < FRAME_WIDTH * 12 && x >= 58) || (i >= FRAME_WIDTH * 32 && x < 22)) {
      edgeDifference += delta;
      edgePixels++;
    }
  }
  const motion = difference / (frame.length * 255);
  return { motion, hudMotion: edgeDifference / (edgePixels * 255), cut: changedPixels > frame.length * 0.8 && motion > 0.23 };
}

function audioRms(block) {
  if (!block || block.length < 2) return 0;
  let squareSum = 0;
  const sampleCount = Math.floor(block.length / 2);
  for (let i = 0; i < sampleCount; i++) {
    const amplitude = block.readInt16LE(i * 2) / 32768;
    squareSum += amplitude * amplitude;
  }
  return Math.sqrt(squareSum / sampleCount);
}

function startScan(args, jobId) {
  const proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (jobId) jobs.register(jobId, proc);
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const completed = new Promise((resolve) => {
    proc.on('error', resolve);
    proc.on('close', (code) => resolve(code === 0 ? null : new Error(`Highlight scan exited ${code}: ${stderr.trim()}`)));
  });
  return { proc, completed };
}

async function detectHighlights(filePath, meta, { jobId, onProgress, audioTrack = 0, inputArgs = [] } = {}) {
  if (jobId && jobs.get(jobId)?.cancelled) throw new jobs.CancelledError();
  const { duration, hasAudio } = meta;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (!['mix', 'none'].includes(audioTrack) && (!Number.isSafeInteger(audioTrack) || audioTrack < 0)) {
    throw new Error('Select a valid audio track');
  }
  const videoMap = Number.isInteger(meta.videoStreamIndex) ? `0:${meta.videoStreamIndex}` : '0:V:0';

  // inputArgs contains the caller's validated input options. Separate streaming
  // processes keep stdout binary and work with Windows pipes.
  // The audio pass demuxes the file and decodes only the selected audio stream.
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-filter_threads', '1',
    ...inputArgs, '-i', filePath, '-t', String(duration)];
  const scans = [];
  try {
    const videoScan = startScan([...args, '-map', videoMap, '-an', '-vf',
      `fps=${SAMPLE_RATE}:start_time=0,scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=fast_bilinear,format=gray`,
      '-threads:v', '1', '-f', 'rawvideo', 'pipe:1'], jobId);
    scans.push(videoScan);
    const frames = blocks(videoScan.proc.stdout, FRAME_WIDTH * FRAME_HEIGHT);
    let audioBlocks;
    if (hasAudio && audioTrack !== 'none') {
      const trackCount = meta.audioTracks?.length || 1;
      const mixed = audioTrack === 'mix' && trackCount > 1;
      const mixInputs = mixed ? Array.from({ length: trackCount }, (_, index) => `[0:a:${index}]`).join('') : '';
      const resample = `aresample=${AUDIO_HZ}:async=1:first_pts=0`;
      const mapping = mixed
        ? ['-filter_complex', `${mixInputs}amix=inputs=${trackCount}:duration=longest,${resample}[audio]`, '-map', '[audio]']
        : ['-map', `0:a:${audioTrack === 'mix' ? 0 : audioTrack}`, '-af', resample];
      const audioScan = startScan([...args, ...mapping, '-vn', '-ac', '1', '-f', 's16le', 'pipe:1'], jobId);
      scans.push(audioScan);
      audioBlocks = blocks(audioScan.proc.stdout, AUDIO_HZ * 2 / SAMPLE_RATE, true);
    }

    const ranker = createRanker(duration);
    let previous;
    let index = 0;
    let lastProgress = 0;
    while (true) {
      const [frame, audio] = await Promise.all([frames.next(), audioBlocks?.next()]);
      if (frame.done && (!audio || audio.done)) break;
      const time = index / SAMPLE_RATE;
      ranker.add({ time, ...frameMotion(frame.value, previous), audio: audioRms(audio?.value) });
      previous = frame.value;
      index++;
      const progress = Math.min(99, Math.floor(index / SAMPLE_RATE / duration * 100));
      if (progress > lastProgress) onProgress?.(progress);
      lastProgress = progress;
    }

    const errors = await Promise.all(scans.map(({ completed }) => completed));
    if (jobId && jobs.isCancelled(jobId)) throw new jobs.CancelledError();
    const error = errors.find(Boolean);
    if (error) throw error;
    onProgress?.(100);
    return ranker.results();
  } catch (error) {
    if (jobId && jobs.isCancelled(jobId)) throw new jobs.CancelledError();
    throw error;
  } finally {
    for (const { proc } of scans) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }
    await Promise.all(scans.map(({ completed }) => completed));
  }
}

module.exports = { detectHighlights, rankHighlights };
