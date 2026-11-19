'use strict';

const { randomUUID } = require('node:crypto');
const jobs = require('../main/jobs');
const { AutomationError, publicError } = require('./errors');

function createJobQueue({ concurrency = 1, maxQueued = 8, maxRetained = 32, onEvict = () => {} } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
      !Number.isSafeInteger(maxQueued) || maxQueued < 0 ||
      !Number.isSafeInteger(maxRetained) || maxRetained < 1) {
    throw new RangeError('Invalid job queue limits.');
  }

  const pending = [];
  const records = new Map();
  const completed = [];
  let running = 0;

  function retain(status) {
    completed.push(status.jobId);
    if (completed.length > maxRetained) {
      const evicted = completed.shift();
      records.delete(evicted);
      onEvict(evicted);
    }
  }

  async function execute({ status, run }) {
    const { jobId } = status;
    running += 1;
    jobs.create(jobId);
    status.state = 'running';
    const report = ({ stage, percent } = {}) => {
      if (status.state !== 'running') return;
      if (typeof stage === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(stage)) status.stage = stage;
      if (Number.isFinite(percent)) status.percent = Math.max(0, Math.min(100, Math.round(percent)));
    };

    try {
      const result = await run({ jobId, report });
      if (jobs.isCancelled(jobId)) {
        status.state = 'cancelled';
      } else {
        status.result = structuredClone(result);
        status.state = 'succeeded';
        status.percent = 100;
      }
    } catch (error) {
      if (jobs.isCancelled(jobId) || error?.isCancelled) {
        status.state = 'cancelled';
      } else {
        status.state = 'failed';
        status.error = publicError(error);
      }
    } finally {
      jobs.done(jobId);
      retain(status);
      running -= 1;
      drain();
    }
  }

  function drain() {
    while (running < concurrency && pending.length) void execute(pending.shift());
  }

  function submit(run) {
    if (typeof run !== 'function') throw new TypeError('A job runner is required.');
    if (running + pending.length >= concurrency + maxQueued) {
      throw new AutomationError('QUEUE_FULL', 'The video job queue is full.');
    }
    const jobId = randomUUID();
    const status = { jobId, state: 'queued', stage: null, percent: 0 };
    records.set(jobId, status);
    pending.push({ status, run });
    queueMicrotask(drain);
    return jobId;
  }

  function get(jobId) {
    const status = records.get(jobId);
    return status ? structuredClone(status) : null;
  }

  function cancel(jobId) {
    const status = records.get(jobId);
    if (status?.state === 'queued') {
      pending.splice(pending.findIndex((job) => job.status === status), 1);
      status.state = 'cancelled';
      retain(status);
      return true;
    }
    if (status?.state !== 'running' || !jobs.cancel(jobId)) return false;
    status.state = 'cancelling';
    return true;
  }

  function cancelAll() {
    for (const jobId of records.keys()) cancel(jobId);
  }

  return { submit, get, cancel, cancelAll };
}

module.exports = { createJobQueue };
