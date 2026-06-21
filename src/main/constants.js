'use strict';

/** Shared constants used across main + renderer (kept dependency-free). */

const ASPECT_RATIOS = {
  '9:16': { w: 1080, h: 1920, label: '9:16 (Reels / Shorts / TikTok)' },
  '16:9': { w: 1920, h: 1080, label: '16:9 (YouTube / Landscape)' },
  '1:1': { w: 1080, h: 1080, label: '1:1 (Square / Instagram)' },
  '4:5': { w: 1080, h: 1350, label: '4:5 (Instagram Portrait)' },
  original: { w: 0, h: 0, label: 'Original (no reframe)' },
};

const REFRAME_MODES = {
  crop: 'Fill screen — crop sides (full screen)',
  smart: 'AI smart fill — keep subject in frame (needs AI)',
  blur: 'Blurred pad — show full scene with bars',
};

const DEFAULTS = {
  targetLengthSec: 30,
  minLengthSec: 20,
  maxLengthSec: 50,
  sceneThreshold: 0.4, // 0.3 sensitive, 0.4 default, 0.5 only hard cuts
  aspectRatio: '9:16',
  reframeMode: 'crop', // full-screen fill by default; 'blur' keeps the whole scene with bars
  aiEnabled: false,
  hwAccel: 'auto', // auto | nvenc | qsv | amf | cpu
  exportConcurrency: 2,
  cutConcurrency: 2, // clips encoded in parallel
  aiModelVision: 'google/gemini-2.5-flash',
  aiModelText: 'google/gemini-2.5-flash-lite',
  whisperModel: 'base',
  burnCaptions: false,
  burnTitle: true, // burn the AI hook title on clips when the AI layer is on
};

const STAGES = {
  PROBE: 'probe',
  SCENES: 'scenes',
  SEGMENT: 'segment',
  THUMBS: 'thumbs',
  AI: 'ai',
  TRANSCRIBE: 'transcribe',
  CUT: 'cut',
  EXPORT: 'export',
};

module.exports = { ASPECT_RATIOS, REFRAME_MODES, DEFAULTS, STAGES };
