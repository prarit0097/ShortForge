'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const jobs = require('../main/jobs');
const { DEFAULTS, STAGES } = require('../main/constants');
const { analyzeVideo, renderVideo } = require('../main/services/pipeline');
const { probe } = require('../main/services/probe');
const { createJobQueue } = require('./job-queue');
const { isWithin, localMediaInputArgs, resolveLocalMedia } = require('./local-media');
const { AutomationError, publicError } = require('./errors');
const { MAX_PLAN_CLIPS, analyzeInput, renderInput, validated } = require('./schemas');

const MAX_SOURCE_SECONDS = 8 * 60 * 60;
const MAX_SOURCE_BYTES = 64n * 1024n ** 3n;
const LOCAL_SETTINGS = { ...DEFAULTS, aiEnabled: false, burnCaptions: false, burnTitle: false, hwAccel: 'cpu' };
const SOURCE_STAT_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];

async function approvedRoot(directory, name) {
  try {
    const resolved = await fs.realpath(directory);
    if (!path.isAbsolute(directory) || (process.platform === 'win32' && resolved.startsWith('\\\\'))) {
      throw new Error('Invalid root');
    }
    const stat = await fs.stat(resolved, { bigint: true });
    if (!stat.isDirectory()) throw new Error('Invalid root');
    return { path: resolved, name, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
  } catch (_) {
    throw new AutomationError('INVALID_ROOT', `Configure the ${name} root as an absolute path to an existing local directory.`);
  }
}

function sameDirectory(first, second) {
  return first.path === second.path && first.dev === second.dev && first.ino === second.ino &&
    first.birthtimeNs === second.birthtimeNs;
}

async function checkRoot(root) {
  const current = await approvedRoot(root.path, root.name);
  if (!sameDirectory(current, root)) {
    throw new AutomationError('INVALID_ROOT', `The configured ${root.name} directory changed.`);
  }
}

function invalidWorkspace() {
  return new AutomationError('INVALID_WORKSPACE', 'The render workspace changed or is outside the output folder.');
}

async function workspaceSnapshot(output, directory) {
  const workspace = await approvedRoot(directory, 'render workspace').catch(() => null);
  if (!workspace || workspace.path !== directory || !isWithin(output.path, workspace.path)) {
    throw invalidWorkspace();
  }
  return workspace;
}

async function checkWorkspace(output, workspace) {
  await checkRoot(output);
  const current = await workspaceSnapshot(output, workspace.path);
  if (!sameDirectory(current, workspace)) throw invalidWorkspace();
}

function sameSource(first, second) {
  return first.filePath === second.filePath && first.demuxer === second.demuxer &&
    SOURCE_STAT_FIELDS.every((field) => first.stat[field] === second.stat[field]);
}

async function mediaSnapshot(root, source) {
  await checkRoot(root);
  const resolved = await resolveLocalMedia(root.path, source);
  const stat = await fs.stat(resolved.filePath, { bigint: true });
  if (!stat.isFile()) throw new AutomationError('INVALID_SOURCE', 'The source is no longer a regular media file.');
  await checkRoot(root);
  return { ...resolved, stat };
}

async function checkSource(root, source, previous) {
  const current = await mediaSnapshot(root, source).catch(() => null);
  if (!current || !sameSource(previous, current)) {
    throw new AutomationError('SOURCE_CHANGED', 'The source changed. Analyze the recording again.');
  }
}

function identifySegments(segments, snapshot, mode, options) {
  const { filePath, demuxer, stat } = snapshot;
  const planKey = JSON.stringify([filePath, demuxer, SOURCE_STAT_FIELDS.map((field) => String(stat[field])), mode, options]);
  return segments.map((segment) => {
    const { index, start, end } = segment;
    const hash = createHash('sha256').update(planKey).update(JSON.stringify([index, start, end])).digest('hex').slice(0, 12);
    return { ...segment, id: `segment-${index + 1}-${hash}` };
  });
}

function clipMetadata({ id, start, end, duration, confidence, signal, reason, peak }) {
  return { id, start, end, duration, confidence, signal, reason, peak };
}

function mediaMetadata({ duration, width, height, fps, videoCodec, audioCodec, hasAudio, sizeBytes }) {
  return { duration, width, height, fps, videoCodec, audioCodec, hasAudio, sizeBytes };
}

async function createAutomation({ inputRoot, outputRoot } = {}) {
  const [input, output] = await Promise.all([approvedRoot(inputRoot, 'input'), approvedRoot(outputRoot, 'output')]);
  const manifests = new Map();
  const queue = createJobQueue({ onEvict: (jobId) => manifests.delete(jobId) });

  function submitAnalysis(args) {
    const { source, mode, ...options } = validated(analyzeInput, args);
    const settings = { ...LOCAL_SETTINGS, ...options, analysisMode: mode };
    const jobId = queue.submit(async ({ jobId, report }) => {
      const snapshot = await mediaSnapshot(input, source);
      if (snapshot.stat.size > MAX_SOURCE_BYTES) {
        throw new AutomationError('SOURCE_TOO_LARGE', 'The source exceeds the 64 GiB analysis limit.');
      }
      const inputArgs = localMediaInputArgs(snapshot.demuxer);
      const { filePath } = snapshot;
      await checkSource(input, source, snapshot);
      const preliminary = await probe(filePath, { jobId, inputArgs });
      await checkSource(input, source, snapshot);
      if (preliminary.duration > MAX_SOURCE_SECONDS) {
        throw new AutomationError('SOURCE_TOO_LONG', 'The source exceeds the eight-hour analysis limit.');
      }
      const plan = await analyzeVideo({
        filePath, settings, jobId, inputArgs, metadata: preliminary,
        onProgress: (stage, percent) => report({ stage, percent }),
      });
      await checkSource(input, source, snapshot);
      if (plan.segments.length > MAX_PLAN_CLIPS) {
        throw new AutomationError('PLAN_TOO_LARGE', 'The plan exceeds 1,000 segments. Try longer clip lengths.');
      }
      if (jobs.isCancelled(jobId)) return;
      const { meta, sceneCount } = plan;
      const segments = identifySegments(plan.segments, snapshot, mode, options);
      manifests.set(jobId, { source, snapshot, meta, segments });
      return { analysisId: jobId, mode, meta: mediaMetadata(meta), sceneCount,
        segments: segments.map(clipMetadata) };
    });
    return { jobId };
  }

  function submitRender(args) {
    const { analysisId, segmentIds, ...options } = validated(renderInput, args);
    const plan = manifests.get(analysisId);
    if (!plan || queue.get(analysisId)?.state !== 'succeeded') {
      throw new AutomationError('UNKNOWN_ANALYSIS', 'This analysis is unknown or expired. Analyze the recording again.');
    }
    const byId = new Map(plan.segments.map((segment) => [segment.id, segment]));
    const segments = segmentIds.map((id) => byId.get(id));
    if (segments.some((segment) => !segment)) {
      throw new AutomationError('UNKNOWN_SEGMENT', 'Use segment IDs from this source and the same analysis settings.');
    }
    const segmentIdsByIndex = new Map(segments.map(({ index, id }) => [index, id]));
    const settings = { ...LOCAL_SETTINGS, ...options, cutConcurrency: 1 };
    const { source, snapshot, meta } = plan;
    const jobId = queue.submit(async ({ jobId, report }) => {
      await checkSource(input, source, snapshot);
      await checkRoot(output);
      if (jobs.isCancelled(jobId)) return;
      const workDir = await fs.mkdtemp(path.join(output.path, 'shortforge-'));
      const workspace = await workspaceSnapshot(output, workDir);
      let keep = false;
      try {
        await checkSource(input, source, snapshot);
        await checkWorkspace(output, workspace);
        if (jobs.isCancelled(jobId)) return;
        const results = await renderVideo({
          filePath: snapshot.filePath, segments, workDir, settings, meta, jobId,
          inputArgs: localMediaInputArgs(snapshot.demuxer),
          onProgress: (percent) => report({ stage: STAGES.CUT, percent }),
        });
        await checkSource(input, source, snapshot);
        await checkWorkspace(output, workspace);
        if (jobs.isCancelled(jobId)) return;
        const clips = await Promise.all(results.map(async ({ index, status, fileName, outputPath }) => {
          const segmentId = segmentIdsByIndex.get(index);
          if (status !== 'ready') {
            return { segmentId, status, error: { code: 'CLIP_FAILED', message: 'The clip could not be rendered.' } };
          }
          const canonicalFile = await fs.realpath(outputPath);
          if (outputPath !== canonicalFile || !isWithin(workspace.path, canonicalFile) ||
              !(await fs.stat(canonicalFile)).isFile()) throw invalidWorkspace();
          return { segmentId, status, fileName,
            artifact: path.relative(output.path, outputPath).split(path.sep).join('/') };
        }));
        await checkWorkspace(output, workspace);
        if (jobs.isCancelled(jobId)) return;
        const ready = clips.filter((clip) => clip.status === 'ready').length;
        keep = ready > 0;
        const outcome = ready === clips.length ? 'ready' : ready ? 'partial' : 'failed';
        return { analysisId, outcome, clips };
      } finally {
        if (!keep) {
          await checkWorkspace(output, workspace).then(() => fs.rm(workDir, { recursive: true, force: true })).catch(() => {});
        }
      }
    });
    return { jobId };
  }

  function getJob(jobId) {
    const status = queue.get(jobId);
    if (!status) throw new AutomationError('UNKNOWN_JOB', 'This job is unknown or expired.');
    return status;
  }

  return {
    analyzeVideo: submitAnalysis, renderClips: submitRender,
    getJob, cancelJob: (jobId) => ({ cancelled: queue.cancel(jobId) }), close: queue.cancelAll,
  };
}

function configuredAutomation(env = process.env) {
  return createAutomation({ inputRoot: env.SHORTFORGE_INPUT_ROOT, outputRoot: env.SHORTFORGE_OUTPUT_ROOT });
}

module.exports = { createAutomation, configuredAutomation, publicError };
