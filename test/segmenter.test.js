'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSegments } = require('../src/main/services/segmenter');

function assertCoverage(segments, duration, min = 0, max = Infinity) {
  let previousEnd = 0;
  for (const [index, segment] of segments.entries()) {
    assert.equal(segment.index, index);
    assert.equal(segment.start, previousEnd);
    assert.ok(segment.duration > 0);
    assert.ok(Math.abs(segment.duration - (segment.end - segment.start)) < 1e-9);
    assert.ok(segment.duration >= min - 1e-9, `segment ${index} is shorter than ${min}`);
    assert.ok(segment.duration <= max + 1e-9, `segment ${index} is longer than ${max}`);
    previousEnd = segment.end;
  }
  assert.equal(previousEnd, duration);
}

test('covers positive sources shorter than the minimum without truncating timestamps', () => {
  for (const duration of [0.0004, 0.05, 7.123456]) {
    assert.deepEqual(buildSegments([], duration), [{ index: 0, start: 0, end: duration, duration }]);
  }
  assert.deepEqual(buildSegments([], 0), []);
});

test('uses the nearest feasible scene and breaks ties at the earlier scene', () => {
  const segments = buildSegments([35, 27, 33, 27, 0, 60, 90], 60);
  assert.deepEqual(segments.map((segment) => segment.end), [27, 60]);
  assertCoverage(segments, 60, 20, 50);
});

test('skips a closer scene when the remaining duration cannot fit the length bounds', () => {
  const options = { minLengthSec: 20, maxLengthSec: 22, targetLengthSec: 20 };
  const segments = buildSegments([20, 21], 65, options);
  assert.deepEqual(segments.map((segment) => segment.end), [21, 43, 65]);
  assertCoverage(segments, 65, 20, 22);
});

test('falls back to the latest cut that leaves enough footage for the final clip', () => {
  const segments = buildSegments([], 55);
  assert.deepEqual(segments.map((segment) => segment.end), [35, 55]);
  assertCoverage(segments, 55, 20, 50);
});

test('hard-splits at the maximum where the remainder is feasible', () => {
  const segments = buildSegments([], 120);
  assert.deepEqual(segments.map((segment) => segment.end), [50, 100, 120]);
  assertCoverage(segments, 120, 20, 50);
});

test('uses the fewest ceiling-compliant clips and divides them evenly when both bounds cannot hold', () => {
  const options = { minLengthSec: 30, maxLengthSec: 50 };
  const segments = buildSegments([38, 45], 55, options);
  assert.deepEqual(segments.map((segment) => segment.end), [27.5, 55]);
  assertCoverage(segments, 55, 0, 50);
});

test('covers two hours of footage with dense scene timestamps', () => {
  const duration = 7200;
  const sceneTimes = Array.from({ length: duration * 60 - 1 }, (_, index) => (index + 1) / 60);
  const segments = buildSegments(sceneTimes, duration);
  assert.equal(segments.length, 240);
  assertCoverage(segments, duration, 20, 50);
});
