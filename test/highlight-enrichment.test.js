'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { candidateShortlist, enrichmentSamples } = require('../src/main/services/highlight-enrichment');
const { enrichSegment } = require('../src/main/services/openrouter');

test('limits cloud enrichment to the strongest ten gameplay moments', () => {
  const segments = Array.from({ length: 15 }, (_, index) => ({ index, confidence: index }));
  assert.deepEqual(candidateShortlist(segments, 'gameplay').map(({ index }) => index),
    [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  assert.equal(candidateShortlist(segments, 'coverage'), segments);
  assert.deepEqual(enrichmentSamples({ index: 0, start: 10, end: 20, peak: 14 }, 'gameplay')
    .map(({ peak }) => peak), [11.5, 14, 18.5]);
});

test('sends temporal samples and returns a bounded gameplay label and score', async (t) => {
  let body;
  const fetch = global.fetch;
  t.after(() => { global.fetch = fetch; });
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      title: 'Narrow escape', eventType: 'near miss', viralityScore: 120, subjectX: -4,
    }) } }] }) };
  };
  const clip = { index: 0, duration: 9 };
  const frames = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg==', 'data:image/jpeg;base64,Yw=='];
  const result = await enrichSegment('fake-test-key', { vision: 'fixture' }, clip, frames, '', { gameplay: true });
  assert.match(body.messages[0].content, /chase.*near miss/i);
  const content = body.messages[1].content;
  assert.deepEqual(content.filter((item) => item.type === 'image_url').map((item) => item.image_url.url), frames);
  assert.doesNotMatch(content[0].text, /Transcript:/);
  assert.equal(result.eventType, 'near miss');
  assert.equal(result.viralityScore, 100);
  assert.equal(result.cropBias, -1);
});
