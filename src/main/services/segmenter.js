'use strict';

function buildSegments(sceneTimes, duration, opts = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const target = Math.max(1, opts.targetLengthSec || 30);
  const min = Math.max(1, opts.minLengthSec || 20);
  const max = Math.max(min, opts.maxLengthSec || 50);
  const epsilon = 8 * Number.EPSILON * Math.max(1, duration);
  const segments = [];
  let start = 0;

  function append(end) {
    segments.push({ index: segments.length, start, end, duration: end - start });
    start = end;
  }

  // At least one whole clip count must satisfy both length bounds.
  function canCover(seconds) {
    if (seconds === 0) return true;
    const fewestClips = Math.max(1, Math.ceil((seconds - epsilon) / max));
    return fewestClips <= Math.floor((seconds + epsilon) / min);
  }

  if (!canCover(duration)) {
    // Spread the shortfall across the fewest clips that respect the maximum.
    const count = Math.ceil((duration - epsilon) / max);
    for (let i = 1; i < count; i++) append((duration / count) * i);
    append(duration);
    return segments;
  }

  const boundaries = [...new Set(sceneTimes.filter((time) => time > 0 && time < duration))]
    .sort((a, b) => a - b);
  boundaries.push(duration);
  let firstInBand = 0;

  while (start < duration) {
    const ideal = start + target;
    const low = start + min - epsilon;
    const high = start + max;
    while (boundaries[firstInBand] < low) firstInBand++;

    let cut;
    let closestDistance = Infinity;
    for (let i = firstInBand; i < boundaries.length && boundaries[i] <= high + epsilon; i++) {
      const boundary = boundaries[i];
      const distance = Math.abs(boundary - ideal);
      if (distance >= closestDistance) break;
      if (canCover(duration - boundary)) {
        cut = boundary;
        closestDistance = distance;
      }
    }

    if (cut === undefined) {
      // Reserve the minimum for the smallest number of trailing clips that can fit.
      const trailingClips = Math.max(0, Math.ceil((duration - high - epsilon) / max));
      cut = trailingClips === 0 ? duration : Math.min(high, duration - trailingClips * min);
    }
    append(cut);
  }

  return segments;
}

module.exports = { buildSegments };
