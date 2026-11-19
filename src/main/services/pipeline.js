'use strict';

const jobs = require('../jobs');
const { STAGES } = require('../constants');
const { probe } = require('./probe');
const { detectScenes, detectKeyframes } = require('./scenes');
const { buildSegments } = require('./segmenter');
const { cutAll } = require('./cutter');

async function analyzeVideo({ filePath, settings, jobId, inputArgs = [], onProgress = () => {} }) {
  const meta = await probe(filePath, { jobId, inputArgs });
  if (!meta.width || !meta.height || !(meta.duration > 0)) throw new Error('No playable video was found.');
  onProgress(STAGES.PROBE, 100, `Duration ${meta.duration.toFixed(1)}s`);
  const options = { jobId, inputArgs, videoStreamIndex: meta.videoStreamIndex };
  let sceneTimes;
  if (settings.scanMode === 'fast') {
    onProgress(STAGES.SCENES, 5, 'Scanning keyframes…');
    sceneTimes = await detectKeyframes(filePath, { ...options, startTime: meta.startTime });
  } else {
    sceneTimes = await detectScenes(filePath, {
      ...options, threshold: settings.sceneThreshold, totalDurationSec: meta.duration,
      onProgress: (percent) => onProgress(STAGES.SCENES, percent, 'Detecting scenes…'),
    });
  }
  if (jobId && jobs.isCancelled(jobId)) throw new jobs.CancelledError();
  onProgress(STAGES.SCENES, 100, `${sceneTimes.length} ${settings.scanMode === 'fast' ? 'keyframes' : 'scene changes'}`);

  const segments = buildSegments(sceneTimes, meta.duration, settings).map((segment) => ({ ...segment, selected: true }));
  onProgress(STAGES.SEGMENT, 100, `${segments.length} shorts planned`);
  return { meta, sceneCount: sceneTimes.length, segments, shortsCount: segments.length };
}

function renderVideo({ filePath, segments, workDir, settings, meta, jobId, inputArgs, preview, onProgress }) {
  return cutAll(filePath, segments, workDir, {
    jobId, inputArgs, preview,
    ratioKey: settings.aspectRatio,
    reframeMode: settings.reframeMode,
    hwAccel: settings.hwAccel,
    quality: settings.outputQuality,
    enhance: !!settings.enhance,
    hasAudio: meta.hasAudio,
    audioTracks: meta.audioTracks,
    audioTrack: settings.audioTrack,
    videoStreamIndex: meta.videoStreamIndex,
    srcW: meta.width,
    srcH: meta.height,
    concurrency: settings.cutConcurrency || 2,
    onProgress,
  });
}

module.exports = { analyzeVideo, renderVideo };
