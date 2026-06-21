'use strict';

/**
 * Tracks long-running child processes so they can report progress and be cancelled.
 * Each job has an id; spawned ffmpeg/whisper processes register here.
 */

const jobs = new Map(); // jobId -> { procs:Set<ChildProcess>, cancelled:boolean }

/**
 * Dedicated cancellation error. Carrying an `isCancelled` flag means callers never
 * have to substring-match the message 'cancelled' (which could appear legitimately
 * in ffmpeg/ffprobe stderr or a filename) to detect a user cancel.
 */
class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
    this.isCancelled = true;
  }
}

function create(jobId) {
  const job = { procs: new Set(), cancelled: false };
  jobs.set(jobId, job);
  return job;
}

function get(jobId) {
  return jobs.get(jobId);
}

function register(jobId, proc) {
  const job = jobs.get(jobId) || create(jobId);
  job.procs.add(proc);
  proc.on('close', () => job.procs.delete(proc));
  return proc;
}

function isCancelled(jobId) {
  const job = jobs.get(jobId);
  return !job || job.cancelled;
}

function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  for (const proc of job.procs) {
    try {
      proc.kill('SIGKILL');
    } catch (_) {
      /* already gone */
    }
  }
  job.procs.clear();
  return true;
}

function done(jobId) {
  jobs.delete(jobId);
}

module.exports = { create, get, register, isCancelled, cancel, done, CancelledError };
