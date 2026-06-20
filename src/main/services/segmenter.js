'use strict';

/**
 * Builds FULL-COVERAGE segments from scene-change timestamps.
 *
 * Guarantees: consecutive [start,end] pairs that cover 0 -> duration with no gaps
 * and no overlaps. Each segment snaps to a real scene boundary when one exists inside
 * the allowed length band, otherwise it hard-splits at maxLength. The final remainder
 * (if shorter than minLength) is merged into the previous segment so nothing is dropped.
 */

function buildSegments(sceneTimes, duration, opts = {}) {
  const target = Math.max(1, opts.targetLengthSec || 30);
  const min = Math.max(1, opts.minLengthSec || 20);
  const max = Math.max(min, opts.maxLengthSec || 50);

  // Candidate cut points: 0, every scene change inside the video, and the end.
  const boundaries = [0, ...sceneTimes.filter((t) => t > 0 && t < duration), duration];
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);

  const segments = [];
  let start = 0;

  while (start < duration - 0.05) {
    const ideal = start + target;
    const lo = start + min;
    const hi = start + max;

    // Scene boundaries that fall inside the allowed [min,max] band for this segment.
    const inBand = sorted.filter((b) => b >= lo && b <= hi);

    let cut;
    if (inBand.length) {
      // Pick the boundary closest to the ideal target length.
      cut = inBand.reduce((best, b) =>
        Math.abs(b - ideal) < Math.abs(best - ideal) ? b : best
      );
    } else {
      // No scene boundary in band -> hard split at max (never exceed the cap).
      cut = Math.min(hi, duration);
    }

    if (cut >= duration - 0.05) {
      cut = duration;
    }

    segments.push({ start: +start.toFixed(3), end: +cut.toFixed(3) });
    start = cut;
  }

  // Merge a too-short tail into the previous segment so coverage stays 100%.
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    if (last.end - last.start < min) {
      const prev = segments[segments.length - 2];
      prev.end = last.end;
      segments.pop();
    }
  }

  return segments.map((s, i) => ({
    index: i,
    start: s.start,
    end: s.end,
    duration: +(s.end - s.start).toFixed(3),
  }));
}

module.exports = { buildSegments };
