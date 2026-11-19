'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateTrim, markerRange } = require('../src/renderer/editor');

test('validates finite in-bounds ranges, including the exact end of a short source', () => {
  assert.deepEqual(validateTrim(0, 0.0417, 0.0417), { start: 0, end: 0.0417, duration: 0.0417 });
  assert.equal(validateTrim(NaN, 1, 20), null);
  assert.equal(validateTrim(-0.1, 1, 20), null);
  assert.equal(validateTrim(16, 16, 20), null);
  assert.equal(validateTrim(16, 20.1, 20), null);
});

test('keeps both sides of a marker where possible and shifts near source edges', () => {
  assert.deepEqual(markerRange(50, 120, 20), { start: 43, end: 63, duration: 20 });
  assert.deepEqual(markerRange(1, 120, 20), { start: 0, end: 20, duration: 20 });
  assert.deepEqual(markerRange(119, 120, 20), { start: 100, end: 120, duration: 20 });
  assert.deepEqual(markerRange(4, 5, 20), { start: 0, end: 5, duration: 5 });
  assert.equal(markerRange(0, 0, 20), null);
});
