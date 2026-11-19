'use strict';

function candidateShortlist(segments, mode) {
  if (mode !== 'gameplay') return segments;
  return [...segments].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 10);
}

function enrichmentSamples(segment, mode) {
  const { start, end, peak } = segment;
  if (mode !== 'gameplay' || end - start < 1) return [segment];
  const length = end - start;
  const middle = Number.isFinite(peak) && peak >= start && peak < end ? peak : start + length / 2;
  const times = [...new Set([start + length * 0.15, middle, start + length * 0.85])].sort((a, b) => a - b);
  return times.map((time) => ({ ...segment, peak: time }));
}

module.exports = { candidateShortlist, enrichmentSamples };
