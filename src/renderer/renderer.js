'use strict';

/* ShortForge renderer — drives the whole UI on top of window.api (preload bridge).
   Wrapped in an IIFE: a top-level `const api` would collide with the non-configurable
   global `api` that contextBridge exposes, crashing the whole script. */
(() => {

const $ = (id) => document.getElementById(id);
const api = window.api;

const ASPECT_OPTIONS = {
  '9:16': '9:16 — Reels / Shorts / TikTok',
  '16:9': '16:9 — YouTube / Landscape',
  '1:1': '1:1 — Square / Instagram',
  '4:5': '4:5 — Instagram Portrait',
  original: 'Original — no reframe',
};
const REFRAME_OPTIONS = {
  crop: 'Fill screen — crop sides (full screen)',
  smart: 'AI smart fill — keep subject (needs AI)',
  blur: 'Blurred pad — full scene with bars',
};

const state = {
  settings: {},
  video: null,
  segments: [],
  models: [],
  jobId: null,
  cancelRequested: false,
  exportAttempt: null,
  enriched: false,
  mode: 'coverage',
  sceneCount: null,
  gameplayMessage: '',
  drafts: new Map(),
  recordings: new Map(),
};

const editor = window.shortForgeEditor.createClipEditor({
  fileUrl,
  onMark: addMarker,
  onTrim: (index, range) => editClip(index, range, true),
  onCrop: (index, cropBias) => editClip(index, { cropBias, cropEdited: true }),
  onRender: (index) => process(index),
  onPreview: previewClip,
});

/* ---------------- helpers ---------------- */
function fileUrl(p) {
  return api.toFileUrl(p);
}
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}
function fmtSize(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
function setStep(n, doneUpTo) {
  document.querySelectorAll('.step').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === n);
    el.classList.toggle('done', s < (doneUpTo || n));
  });
}
function newJobId() {
  state.jobId = `job_${Date.now()}_${Math.floor(performance.now())}`;
  return state.jobId;
}

/* ---------------- settings ---------------- */
async function loadSettings() {
  state.settings = await api.getSettings();
  const s = state.settings;
  $('targetLen').value = s.targetLengthSec;
  $('minLen').value = s.minLengthSec;
  $('maxLen').value = s.maxLengthSec;
  $('sceneThreshold').value = s.sceneThreshold;
  $('threshVal').textContent = Number(s.sceneThreshold).toFixed(2);
  $('scanMode').value = s.scanMode || 'accurate';
  $('outputQuality').value = s.outputQuality || 'high';
  $('enhance').checked = !!s.enhance;
  $('burnCaptions').checked = !!s.burnCaptions;
  $('burnTitle').checked = s.burnTitle !== false;
  $('shareTranscriptContext').checked = s.shareTranscriptContext === true;
  ensureOption($('aiModelVision'), s.aiModelVision);
  ensureOption($('aiModelText'), s.aiModelText);
  $('whisperModel').value = s.whisperModel;
  $('hwAccel').value = s.hwAccel;
  $('exportConcurrency').value = s.exportConcurrency;

  fillSelect('aspectRatio', ASPECT_OPTIONS, s.aspectRatio);
  fillSelect('reframeMode', REFRAME_OPTIONS, s.reframeMode);

  setAi(!!s.aiEnabled);
  $('whisperState').textContent = s.whisperAvailable ? '· available' : '· not installed';
  $('keyStatus').textContent = s.hasApiKey ? 'Key saved ✓' : 'No key yet';
  $('keyStatus').className = 'key-status ' + (s.hasApiKey ? 'ok' : '');
}
function fillSelect(id, options, selected) {
  const el = $(id);
  el.innerHTML = '';
  for (const [val, label] of Object.entries(options)) {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    if (val === selected) o.selected = true;
    el.appendChild(o);
  }
}
function setAi(on) {
  state.settings.aiEnabled = on;
  $('aiToggle').classList.toggle('on', on);
  $('aiToggle').setAttribute('aria-pressed', String(on));
  $('aiState').textContent = on ? 'ON' : 'OFF';
  $('enrichBtn').classList.toggle('hidden', !on);
  updateAiDisclosure();
}

function updateAiDisclosure() {
  const disclosure = $('aiDisclosure');
  disclosure.classList.toggle('hidden', !state.settings.aiEnabled);
  const sharing = $('shareTranscriptContext').checked;
  disclosure.textContent = sharing
    ? 'AI enrichment sends clip stills and transcript excerpts to OpenRouter.'
    : 'AI enrichment sends clip stills to OpenRouter. Transcript sharing is off.';
  if (state.mode === 'gameplay') disclosure.textContent += ' Up to 10 selected clips per pass.';
}
/* ---- model dropdowns ---- */
function ensureOption(sel, val) {
  if (!val) return;
  if (![...sel.options].some((o) => o.value === val)) {
    const o = document.createElement('option');
    o.value = val; o.textContent = val;
    sel.appendChild(o);
  }
  sel.value = val;
}

// Curated "cheap + reliable" picks. We recommend the cheapest of these that is
// actually available, instead of the absolute cheapest (often a useless free model).
const RECOMMENDED = {
  vision: [
    'google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash-001', 'google/gemini-2.5-flash',
    'openai/gpt-4o-mini', 'qwen/qwen-2.5-vl-7b-instruct', 'google/gemini-flash-1.5-8b',
    'google/gemini-flash-1.5', 'mistralai/pixtral-12b',
  ],
  text: [
    'google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini', 'google/gemini-2.0-flash-001',
    'mistralai/mistral-small-24b-instruct-2501', 'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-chat',
  ],
};

function priceLabel(m) {
  if (m.isFree) return 'FREE';
  return `$${m.promptPerM}/M in · $${m.completionPerM}/M out`;
}

function pickRecommended(list, visionOnly) {
  const ids = visionOnly ? RECOMMENDED.vision : RECOMMENDED.text;
  const present = ids.map((id) => list.find((m) => m.id === id)).filter(Boolean);
  if (present.length) {
    return present.sort((a, b) => (a.promptPerM + a.completionPerM) - (b.promptPerM + b.completionPerM))[0];
  }
  const paid = list.filter((m) => !m.isFree); // list already sorted cheapest-first
  return paid[0] || list[0];
}

function populateModelSelect(sel, models, current, visionOnly, recEl) {
  const list = (visionOnly ? models.filter((m) => m.isVision) : models)
    .slice()
    .sort((a, b) => (a.promptPerM + a.completionPerM) - (b.promptPerM + b.completionPerM));
  if (!list.length) return;
  const rec = pickRecommended(list, visionOnly);
  const cheapest = list[0];

  sel.innerHTML = '';
  if (current && !list.some((m) => m.id === current)) {
    const o = document.createElement('option');
    o.value = current; o.textContent = `${current} (current)`;
    sel.appendChild(o);
  }
  list.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${rec && m.id === rec.id ? '⭐ ' : ''}${m.name} — ${priceLabel(m)}`;
    sel.appendChild(o);
  });
  sel.value = current && list.some((m) => m.id === current) ? current : (rec ? rec.id : cheapest.id);

  if (recEl && rec) {
    let html = `⭐ Recommended: <a class="link" data-pick="${rec.id}">${rec.name}</a> · ${priceLabel(rec)}`;
    if (cheapest.id !== rec.id) {
      html += ` &nbsp;·&nbsp; absolute cheapest: <a class="link" data-pick="${cheapest.id}">${cheapest.name}</a> (${priceLabel(cheapest)})`;
    }
    recEl.innerHTML = html;
  }
}

async function loadModels() {
  if (!state.settings.hasApiKey) { $('modelStatus').textContent = 'Save your API key first'; return; }
  $('modelStatus').textContent = 'Loading models…';
  try {
    const models = await api.listModels();
    state.models = models;
    populateModelSelect($('aiModelVision'), models, gatherSettings().aiModelVision, true, $('visionRec'));
    populateModelSelect($('aiModelText'), models, gatherSettings().aiModelText, false, $('textRec'));
    const vCount = models.filter((m) => m.isVision).length;
    $('modelStatus').textContent = `${models.length} models (${vCount} vision) · sorted cheapest first`;
  } catch (err) {
    $('modelStatus').textContent = `Failed: ${err.message}`;
  }
}

function gatherSettings() {
  return {
    ...state.settings,
    targetLengthSec: Number($('targetLen').value),
    minLengthSec: Number($('minLen').value),
    maxLengthSec: Number($('maxLen').value),
    sceneThreshold: Number($('sceneThreshold').value),
    scanMode: $('scanMode').value,
    analysisMode: state.mode,
    aspectRatio: $('aspectRatio').value,
    reframeMode: $('reframeMode').value,
    audioTrack: ['mix', 'none'].includes($('audioTrack').value) ? $('audioTrack').value : Number($('audioTrack').value),
    outputQuality: $('outputQuality').value,
    enhance: $('enhance').checked,
    burnCaptions: $('burnCaptions').checked,
    burnTitle: $('burnTitle').checked,
    aiEnabled: state.settings.aiEnabled,
    aiModelVision: $('aiModelVision').value.trim() || state.settings.aiModelVision,
    aiModelText: $('aiModelText').value.trim() || state.settings.aiModelText,
    whisperModel: $('whisperModel').value,
    hwAccel: $('hwAccel').value,
    exportConcurrency: Number($('exportConcurrency').value),
    useTranscript: true,
    shareTranscriptContext: $('shareTranscriptContext').checked,
  };
}
async function persistSettings() {
  const s = gatherSettings();
  await api.setSettings(s);
  state.settings = { ...state.settings, ...s };
}

/* ---------------- progress overlay ---------------- */
function showProgress(title) {
  state.cancelRequested = false;
  $('progTitle').textContent = title;
  $('barFill').style.width = '0%';
  $('progMsg').textContent = 'Starting…';
  $('cancelBtn').disabled = false;
  $('progressOverlay').classList.remove('hidden');
}
function hideProgress() {
  state.jobId = null;
  $('progressOverlay').classList.add('hidden');
}

api.onProgress((d) => {
  if (d.jobId !== state.jobId) return;
  $('barFill').style.width = `${d.percent}%`;
  if (!state.cancelRequested) $('progMsg').textContent = d.message || '';
});

/* ---------------- import ---------------- */
async function addVideo() {
  const files = await api.pickVideos();
  if (!files || !files.length) return;
  const f = files[0];
  if (f.error) { toast(`Could not read file: ${f.error}`, 'err'); return; }
  selectVideo(f);
}

async function startRecordingWatch() {
  const button = $('watchRecordingsBtn');
  const status = $('watchStatus');
  button.disabled = true;
  try {
    const result = await api.watchRecordings();
    if (!result?.folder) return;
    state.recordings.clear();
    renderRecordings();
    button.classList.add('hidden');
    $('stopWatchingBtn').classList.remove('hidden');
    status.textContent = `Watching ${result.folder} for new recordings.`;
    $('stopWatchingBtn').focus();
  } catch (error) {
    status.textContent = `Could not watch this folder. ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function stopRecordingWatch() {
  const button = $('stopWatchingBtn');
  button.disabled = true;
  try {
    await api.stopWatchRecordings();
    button.classList.add('hidden');
    $('watchRecordingsBtn').classList.remove('hidden');
    $('watchStatus').textContent = 'Stopped watching for new recordings.';
    $('watchRecordingsBtn').focus();
  } catch (error) {
    $('watchStatus').textContent = `Could not stop watching. ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function recordingAvailable(recording) {
  if (recording.error) {
    $('watchStatus').textContent = `Recording watch: ${recording.error}`;
    return;
  }
  state.recordings.delete(recording.filePath);
  state.recordings.set(recording.filePath, recording.name);
  if (state.recordings.size > 20) state.recordings.delete(state.recordings.keys().next().value);
  $('watchStatus').textContent = `${recording.name} is ready to import.`;
  renderRecordings();
}

function renderRecordings() {
  const list = $('availableRecordings');
  const focusedPath = list.contains(document.activeElement) ? document.activeElement.dataset.path : undefined;
  list.replaceChildren();
  list.classList.toggle('hidden', state.recordings.size === 0);
  for (const [filePath, name] of [...state.recordings].reverse()) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-btn small';
    button.textContent = 'Import';
    button.dataset.path = filePath;
    button.setAttribute('aria-label', `Import ${name}`);
    button.addEventListener('click', async () => {
      if (state.jobId) return;
      button.disabled = true;
      try {
        const meta = await api.probeFile(filePath);
        if (!meta || meta.error) throw new Error(meta?.error || 'The recording could not be read.');
        selectVideo(meta);
      } catch (error) {
        $('watchStatus').textContent = `Could not import ${name}. ${error.message}`;
      } finally {
        button.disabled = false;
      }
    });
    row.append(label, button);
    list.appendChild(row);
    if (filePath === focusedPath) button.focus({ preventScroll: true });
  }
}

function selectVideo(meta) {
  resetThumbnails();
  state.video = meta;
  state.segments = [];
  state.exportAttempt = null;
  state.enriched = false;
  state.sceneCount = null;
  state.gameplayMessage = '';
  state.drafts.clear();

  $('dropzone').classList.add('hidden');
  $('fileCard').classList.remove('hidden');
  $('fileName').textContent = meta.name;
  $('fileStats').innerHTML = `
    <span>⏱ <b>${fmtDuration(meta.duration)}</b></span>
    <span>📐 <b>${meta.width}×${meta.height}</b></span>
    <span>🎞 <b>${meta.fps} fps</b></span>
    <span>💾 <b>${fmtSize(meta.sizeBytes)}</b></span>
    <span>🔊 <b>${meta.hasAudio ? meta.audioCodec : 'no audio'}</b></span>`;
  $('controlsPanel').classList.remove('hidden');
  $('saveProjectBtn').classList.remove('hidden');
  $('pageTitle').textContent = meta.name;
  $('pageSub').textContent = 'Preview the recording or choose how to plan your clips.';
  fillAudioTracks();
  editor.setSource(meta);
  updateMode();
  setStep(2, 2);
}

function fillAudioTracks(selected = 0) {
  const tracks = state.video?.audioTracks || (state.video?.hasAudio ? [{ index: 0, codec: state.video.audioCodec }] : []);
  const select = $('audioTrack');
  select.replaceChildren();
  for (const [ordinal, track] of tracks.entries()) {
    const title = track.title || (tracks.length === 1 ? 'Source audio' : `Track ${ordinal + 1}`);
    const detail = [track.language, track.codec].filter(Boolean).join(' · ');
    select.add(new Option(detail ? `${title} (${detail})` : title, ordinal));
  }
  if (tracks.length > 1) select.add(new Option('Mix all tracks', 'mix'));
  select.add(new Option(tracks.length ? 'No audio' : 'No audio tracks', 'none'));
  select.disabled = tracks.length === 0;
  if ([...select.options].some((option) => option.value === String(selected))) select.value = selected;
}

function updatePresetButtons() {
  const settings = gatherSettings();
  $('presetHudSafe').setAttribute('aria-pressed', String(settings.aspectRatio === '9:16' && settings.reframeMode === 'blur'));
  $('presetOriginal').setAttribute('aria-pressed', String(settings.aspectRatio === 'original'));
  editor.configure(settings, state.mode === 'gameplay');
}

function updateMode() {
  const gameplay = state.mode === 'gameplay';
  $('clipMode').value = state.mode;
  document.querySelectorAll('[data-coverage]').forEach((field) => field.classList.toggle('hidden', gameplay));
  $('analyzeBtn').textContent = gameplay ? 'Find highlights' : 'Analyze video →';
  $('manualMarkBtn').classList.toggle('hidden', !gameplay);
  $('analyzeHint').textContent = gameplay
    ? 'Scan locally for motion and sound peaks, or mark a moment yourself.'
    : 'Detect scene boundaries and see the plan before rendering.';
  $('resultsPanel').classList.toggle('hidden', !gameplay && !state.segments.length);
  if (gameplay || state.segments.length) renderResults();
  updatePresetButtons();
  updateAiDisclosure();
}

function switchMode(mode) {
  if (mode === state.mode) return;
  state.drafts.set(state.mode, { segments: state.segments, enriched: state.enriched, sceneCount: state.sceneCount, gameplayMessage: state.gameplayMessage });
  state.mode = mode;
  const draft = state.drafts.get(mode);
  state.segments = draft?.segments || [];
  state.sceneCount = draft?.sceneCount ?? null;
  state.gameplayMessage = draft?.gameplayMessage || '';
  state.enriched = !!draft?.enriched;
  state.exportAttempt = null;
  resetThumbnails();
  editor.showSource();
  updateMode();
}

function focusMarker() {
  editor.showSource();
  $('editorPanel').scrollIntoView({ block: 'start' });
  $('editorMark').focus({ preventScroll: true });
}

function addMarker(time) {
  if (state.mode !== 'gameplay' || !state.video) return;
  const range = window.shortForgeEditor.markerRange(time, state.video.duration, Number($('targetLen').value));
  if (!range) { toast('Enter a positive target length in Cutting settings.', 'err'); return; }
  const index = state.segments.reduce((next, clip) => Math.max(next, clip.index + 1), 0);
  const clip = { ...range, index, peak: time, selected: true, reason: `Marked at ${fmtClock(time)}` };
  state.segments.push(clip);
  state.enriched = false;
  renderResults();
  setStep(3, 3);
  editor.review(clip);
}

function editClip(index, changes, resetThumb = false) {
  const clip = state.segments.find((item) => item.index === index);
  Object.assign(clip, changes);
  if (clip.outputPath) clip.needsRender = true;
  if (resetThumb) {
    delete clip.thumbPath;
    clip.aiEnriched = false;
    state.enriched = false;
    renderClips();
  }
  refreshClipCard(clip);
  updateSelCount();
  return clip;
}

async function previewClip(segment) {
  const jobId = newJobId();
  showProgress('Generating playback preview');
  try {
    const settings = { ...gatherSettings(), aspectRatio: 'original', burnTitle: false, burnCaptions: false };
    return await api.previewClip({ filePath: state.video.path, segment: { index: 0, ...segment }, settings, jobId });
  } finally {
    hideProgress();
  }
}

async function saveProject() {
  if (!state.video) return;
  try {
    const res = await api.saveProject({
      sourcePath: state.video.path, mode: state.mode, settings: gatherSettings(),
      segments: state.segments.map((clip) => clip.needsRender ? { ...clip, outputPath: undefined } : clip),
    });
    if (res?.filePath) toast('Project saved', 'ok');
  } catch (error) {
    toast(`Could not save project. ${error.message}`, 'err');
  }
}

async function openProject() {
  try {
    const project = await api.openProject();
    if (!project) return;
    state.mode = project.mode;
    selectVideo(project.video);
    state.segments = project.segments;
    const fields = {
      targetLengthSec: 'targetLen', minLengthSec: 'minLen', maxLengthSec: 'maxLen', sceneThreshold: 'sceneThreshold',
      scanMode: 'scanMode', aspectRatio: 'aspectRatio', reframeMode: 'reframeMode', outputQuality: 'outputQuality',
    };
    for (const [key, id] of Object.entries(fields)) {
      if (project.settings[key] !== undefined) $(id).value = project.settings[key];
    }
    for (const id of ['enhance', 'burnTitle', 'burnCaptions']) {
      if (project.settings[id] !== undefined) $(id).checked = project.settings[id];
    }
    $('threshVal').textContent = Number($('sceneThreshold').value).toFixed(2);
    fillAudioTracks(project.settings.audioTrack);
    updateMode();
    setStep(state.segments.some((clip) => clip.outputPath) ? 5 : 3);
    toast(project.sourceChanged ? 'Source has changed. Review the clip ranges before rendering.' : 'Project opened', project.sourceChanged ? '' : 'ok');
  } catch (error) {
    toast(`Could not open project. ${error.message}`, 'err');
  }
}

/* ---------------- analyze ---------------- */
async function analyze() {
  if (!state.video) return;
  const gameplay = state.mode === 'gameplay';
  await persistSettings();
  const jobId = newJobId();
  showProgress(gameplay ? 'Finding highlights locally' : 'Analyzing video');
  try {
    const res = await api.analyze({ filePath: state.video.path, settings: gatherSettings(), jobId });
    if (res.cancelled) { toast('Analysis cancelled.'); return; }
    if (gameplay) {
      let next = state.segments.reduce((index, clip) => Math.max(index, clip.index + 1), 0);
      const added = [];
      for (const suggestion of res.segments) {
        if (state.segments.some((clip) => suggestion.start < clip.end && suggestion.end > clip.start)) continue;
        added.push({ ...suggestion, index: next++, selected: suggestion.selected !== false });
      }
      state.segments.push(...added);
      state.gameplayMessage = added.length
        ? `${added.length} ${added.length === 1 ? 'suggestion' : 'suggestions'} added. Review the clips before rendering.`
        : res.segments.length ? 'Suggestions overlapped your existing clips.'
          : 'No clear motion or sound peaks. Use Mark manually to add a clip.';
      toast(state.gameplayMessage, added.length ? 'ok' : '');
    } else {
      resetThumbnails();
      editor.showSource();
      state.segments = res.segments;
      state.sceneCount = res.sceneCount;
      state.exportAttempt = null;
      state.enriched = false;
      toast(`${res.shortsCount} shorts planned from ${res.sceneCount} scene changes`, 'ok');
    }
    renderResults(res);
    setStep(3, 3);
  } catch (err) {
    toast(`Analyze failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
  }
}

function renderResults(res) {
  $('resultsPanel').classList.remove('hidden');
  const totalDur = state.video.duration;
  const planLabel = state.mode === 'gameplay'
    ? state.gameplayMessage || 'Scan locally or mark a moment in the recording.'
    : `${fmtDuration(totalDur)}${state.sceneCount == null ? '' : ` · ${state.sceneCount} scene changes`} · full coverage plan`;
  $('summary').innerHTML = `
    <div class="big-num">${state.segments.length} ${state.segments.length === 1 ? 'clip' : 'clips'}</div>
    <div class="meta">${planLabel}</div>
    <div class="meta" id="renderStatus" aria-live="polite"></div>
    <div class="meta" id="exportStatus" aria-live="polite"></div>`;
  renderClips();
  updateSelCount();
  if (res) $('resultsPanel').scrollIntoView({ block: 'start' });
}

function scoreClass(v) {
  if (v == null) return '';
  if (v >= 70) return 'score-hi';
  if (v >= 45) return 'score-mid';
  return 'score-lo';
}

function showBatchStatus(id, message, failures = []) {
  const status = $(id);
  status.textContent = message;
  if (!failures.length) return;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Error details';
  details.appendChild(summary);
  const list = document.createElement('ul');
  for (const { index, error } of failures) {
    const item = document.createElement('li');
    item.textContent = `Short ${index + 1}: ${error}`;
    list.appendChild(item);
  }
  details.appendChild(list);
  status.appendChild(details);
}

const thumbnailQueue = new Map();
const thumbnailAttempts = new Set();
let thumbnailEpoch = 0;
let thumbnailJob;
const thumbnailObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbnailObserver.unobserve(entry.target);
    const clip = state.segments.find((item) => item.index === Number(entry.target.dataset.clip));
    if (!clip || clip.thumbPath) continue;
    const key = `${clip.index}:${clip.start}:${clip.end}`;
    if (thumbnailAttempts.has(key)) continue;
    thumbnailAttempts.add(key);
    thumbnailQueue.set(clip.index, { index: clip.index, start: clip.start, end: clip.end, duration: clip.duration, peak: clip.peak });
  }
  loadThumbnails();
}, { root: $('content'), rootMargin: '120px 0px' });

function resetThumbnails() {
  thumbnailEpoch++;
  thumbnailObserver.disconnect();
  thumbnailQueue.clear();
  thumbnailAttempts.clear();
  if (thumbnailJob) api.cancel(thumbnailJob).catch(() => {});
}

async function loadThumbnails() {
  if (thumbnailJob || !thumbnailQueue.size || !state.video) return;
  const epoch = thumbnailEpoch;
  const segments = [...thumbnailQueue.values()].slice(0, 12);
  for (const { index } of segments) thumbnailQueue.delete(index);
  const ranges = new Map(segments.map((clip) => [clip.index, clip]));
  thumbnailJob = `thumb_${crypto.randomUUID()}`;
  try {
    const result = await api.getThumbnails({ filePath: state.video.path, segments, jobId: thumbnailJob });
    if (epoch !== thumbnailEpoch) return;
    for (const { index, thumbPath } of result?.segments || []) {
      const clip = state.segments.find((item) => item.index === index);
      const range = ranges.get(index);
      if (!thumbPath || !clip || !range || clip.start !== range.start || clip.end !== range.end) continue;
      clip.thumbPath = thumbPath;
      const image = $('clipGrid').querySelector(`[data-clip="${index}"] img`);
      if (image) showThumbnail(image, thumbPath);
    }
  } catch {
    // Clip review and rendering remain available if a thumbnail cannot be read.
  } finally {
    thumbnailJob = null;
    loadThumbnails();
  }
}

async function showThumbnail(image, path) {
  try {
    image.src = await fileUrl(path);
    image.classList.remove('hidden');
  } catch {
    // A missing thumbnail does not prevent clip review.
  }
}

function renderClips() {
  const grid = $('clipGrid');
  thumbnailObserver.disconnect();
  const cards = document.createDocumentFragment();
  for (const seg of state.segments) {
    const card = document.createElement('article');
    card.dataset.clip = seg.index;
    card.className = `clip-card${seg.selected ? ' selected' : ''}`;
    card.innerHTML = `
      <div class="clip-thumb">
        <img alt="" loading="lazy" class="hidden" />
        <button class="clip-check" type="button">✓</button>
        <div class="clip-dur"></div><div class="clip-score hidden"></div>
      </div>
      <div class="clip-body">
        <input class="clip-title" type="text" />
        <div class="clip-range"></div><div class="clip-reason hidden"></div>
        <div class="clip-tags"></div>
        <div class="clip-actions">
          <button class="review-clip" type="button">Review clip</button>
          <button class="reveal-clip hidden" type="button">Show in folder</button>
        </div>
      </div>`;
    const image = card.querySelector('img');
    if (seg.thumbPath) showThumbnail(image, seg.thumbPath);
    else thumbnailObserver.observe(card);
    const check = card.querySelector('.clip-check');
    check.setAttribute('aria-label', `Select clip ${seg.index + 1}`);
    check.setAttribute('aria-pressed', String(Boolean(seg.selected)));
    check.addEventListener('click', () => {
      seg.selected = !seg.selected;
      check.setAttribute('aria-pressed', String(seg.selected));
      card.classList.toggle('selected', seg.selected);
      updateSelCount();
    });
    card.querySelector('.clip-dur').textContent = `${seg.duration.toFixed(1)}s`;
    if (seg.viralityScore != null || seg.confidence != null) {
      const score = card.querySelector('.clip-score');
      const value = seg.viralityScore ?? seg.confidence;
      score.textContent = `${value}${seg.viralityScore == null ? '% signal' : ' AI score'}`;
      score.className = `clip-score ${scoreClass(value)}`;
    }
    const title = card.querySelector('.clip-title');
    title.setAttribute('aria-label', `Title for clip ${seg.index + 1}`);
    title.value = seg.title || `Clip ${seg.index + 1}`;
    title.addEventListener('change', () => {
      editClip(seg.index, { title: title.value, titleEdited: true });
      editor.refreshClip(seg);
    });
    card.querySelector('.clip-range').textContent = `${fmtClock(seg.start)} → ${fmtClock(seg.end)}`;
    refreshClipCard(seg, card.querySelector('.clip-reason'));
    for (const tag of (seg.hashtags || []).slice(0, 3)) {
      const label = document.createElement('span');
      label.textContent = tag;
      card.querySelector('.clip-tags').appendChild(label);
    }
    card.querySelector('.review-clip').addEventListener('click', () => editor.review(seg));
    const reveal = card.querySelector('.reveal-clip');
    reveal.classList.toggle('hidden', !seg.outputPath);
    reveal.addEventListener('click', () => api.showItem(seg.outputPath));
    cards.appendChild(card);
  }
  grid.replaceChildren(cards);
}

function refreshClipCard(clip, details = $('clipGrid').querySelector(`[data-clip="${clip.index}"] .clip-reason`)) {
  if (!details) return;
  const status = clip.needsRender ? 'Rerender needed' : clip.renderStatus === 'failed' ? 'Render failed'
    : clip.renderStatus === 'cancelled' ? 'Render cancelled' : '';
  const event = clip.eventType && clip.eventType !== 'other' ? `AI suggestion: ${clip.eventType}` : '';
  details.textContent = [clip.reason, event, status].filter(Boolean).join(' · ');
  details.classList.toggle('hidden', !details.textContent);
}
function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function needsRender(clip) { return !clip.outputPath || clip.needsRender; }
function updateSelCount() {
  const pending = state.segments.filter((s) => s.selected && needsRender(s));
  const processBtn = $('processBtn');
  const retrying = pending.length > 0 && pending.every((s) => s.renderStatus);
  processBtn.firstChild.nodeValue = retrying ? '↻ Retry processing (' : '▶ Start processing (';
  $('selCount').textContent = pending.length;
  processBtn.classList.toggle('hidden', !state.segments.some(needsRender));
  processBtn.disabled = !pending.length;
  const downloadBtn = $('downloadBtn');
  downloadBtn.classList.toggle('hidden', !state.segments.some((s) => !needsRender(s)));
  downloadBtn.disabled = !state.segments.some((s) => s.selected && !needsRender(s));
  $('enrichBtn').disabled = state.mode === 'gameplay'
    ? !state.segments.some((clip) => clip.selected && isNotEnriched(clip)) : !state.segments.length;
}

/* ---------------- AI enrich ---------------- */
function isNotEnriched(clip) {
  return !(clip.aiEnriched ?? (clip.viralityScore != null || !!clip.aiDescription));
}

async function enrich(clips) {
  if (!state.settings.aiEnabled) { toast('Turn the AI Layer ON first.', 'err'); return false; }
  if (!state.settings.hasApiKey) { toast('Add your OpenRouter API key in Settings.', 'err'); openSettings(); return false; }
  const requested = clips ?? (state.mode === 'gameplay'
    ? state.segments.filter((clip) => clip.selected && isNotEnriched(clip)) : state.segments);
  if (!requested.length) return true;
  await persistSettings();
  const jobId = newJobId();
  showProgress('Enhancing with AI');
  try {
    const res = await api.enrich({ filePath: state.video.path, segments: requested, settings: gatherSettings(), jobId });
    if (res.cancelled) { toast('AI enrichment cancelled.'); return false; }
    const byIndex = new Map(res.segments.map((clip) => [clip.index, clip]));
    state.segments = state.segments.map((original) => {
      const enriched = byIndex.get(original.index);
      if (!enriched || enriched.aiError) return original;
      const clip = {
        ...original, ...enriched, aiEnriched: true,
        title: original.titleEdited ? original.title : enriched.title,
        cropBias: original.cropEdited ? original.cropBias : enriched.cropBias,
      };
      if (clip.outputPath && (clip.title !== original.title || clip.cropBias !== original.cropBias)) clip.needsRender = true;
      editor.refreshClip(clip);
      return clip;
    });
    state.enriched = true;
    renderClips();
    updateSelCount();
    const enhanced = res.segments.filter((clip) => !clip.aiError).length;
    const failed = res.segments.length - enhanced;
    const remaining = requested.length - res.segments.length;
    let message = `${enhanced} ${enhanced === 1 ? 'clip enhanced' : 'clips enhanced'}`;
    if (failed) message += ` · ${failed} failed`;
    if (remaining > 0) message += ` · ${remaining} available for another pass`;
    toast(message, failed ? 'err' : 'ok');
    return true;
  } catch (err) {
    toast(`AI enhance failed: ${err.message}`, 'err');
    return false;
  } finally {
    hideProgress();
  }
}

/* ---------------- process ---------------- */
async function process(index) {
  const selectedForRender = (clip) => index === undefined ? clip.selected && needsRender(clip) : clip.index === index;
  let selected = state.segments.filter(selectedForRender);
  if (!selected.length) { toast('Select at least one short to process.', 'err'); return; }

  // If the AI layer is on but clips haven't been enhanced yet, do it now so the AI
  // titles/scores/crop actually drive the output (otherwise AI-on == AI-off).
  const gameplay = state.mode === 'gameplay';
  const forEnrichment = gameplay ? selected.filter(isNotEnriched) : state.enriched ? [] : state.segments;
  if (state.settings.aiEnabled && forEnrichment.length) {
    if (!state.settings.hasApiKey) {
      toast('AI Layer is ON but no API key set. Add it in Settings, or turn AI off.', 'err');
      openSettings();
      return;
    }
    if (!await enrich(forEnrichment)) return;
    selected = state.segments.filter(selectedForRender);
  }

  await persistSettings();
  const jobId = newJobId();
  showProgress(selected.length === 1 ? 'Rendering clip' : `Rendering ${selected.length} clips`);
  try {
    const res = await api.process({ filePath: state.video.path, segments: selected, settings: gatherSettings(), jobId });
    const results = res.results || selected.map(({ index }) => ({ index, status: 'cancelled' }));
    const byIndex = new Map(results.map((result) => [result.index, result]));
    state.segments = state.segments.map((seg) => {
      const result = byIndex.get(seg.index);
      if (!result) return seg;
      const renderStatus = result.status;
      if (renderStatus === 'ready') {
        state.exportAttempt?.saved.delete(seg.outputPath);
        state.exportAttempt?.pending.delete(seg.outputPath);
        seg = { ...seg, renderStatus, outputPath: result.outputPath, fileName: result.fileName, needsRender: false };
      } else {
        seg = { ...seg, renderStatus };
      }
      editor.refreshClip(seg);
      return seg;
    });
    renderClips();
    updateSelCount();
    if (state.segments.some((seg) => seg.outputPath)) setStep(5, 5);
    const ready = results.filter((result) => result.status === 'ready').length;
    const failures = results.filter((result) => result.status === 'failed');
    const cancelled = results.filter((result) => result.status === 'cancelled').length;
    const message = `${ready}/${selected.length} shorts rendered` +
      (failures.length ? ` • ${failures.length} failed` : '') +
      (cancelled ? ` • ${cancelled} cancelled` : '');
    showBatchStatus('renderStatus', message, failures);
    toast(message, failures.length ? 'err' : cancelled ? '' : 'ok');
    if (res.captionsSkipped) {
      toast('No local transcript was available. Check that Whisper is installed and the selected audio has speech.', 'err');
    }
  } catch (err) {
    showBatchStatus('renderStatus', `Processing failed. ${err.message}`);
    toast(`Processing failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
  }
}

/* ---------------- export ---------------- */
async function batchDownload() {
  let selectedClips = state.segments.filter((s) => s.selected && !needsRender(s));
  if (!selectedClips.length) { toast('Select processed shorts to download.', 'err'); return; }
  const dest = await api.pickFolder();
  if (!dest) return;
  const attempt = state.exportAttempt?.dest === dest
    ? state.exportAttempt
    : { dest, saved: new Set(), pending: new Set() };
  selectedClips = selectedClips.filter((seg) => !attempt.saved.has(seg.outputPath));
  if (!selectedClips.length) { toast('These shorts were already exported to this folder.'); return; }
  const jobId = newJobId();
  showProgress(`Downloading ${selectedClips.length} shorts`);
  try {
    const res = await api.exportClips({
      clips: selectedClips.map((s) => ({ index: s.index, outputPath: s.outputPath, fileName: s.fileName })),
      destDir: dest, settings: gatherSettings(), jobId,
    });
    const ready = res.results.filter((result) => result.status === 'ready');
    const failures = res.results.filter((result) => result.status === 'failed');
    const cancelled = res.results.filter((result) => result.status === 'cancelled').length;
    for (const result of res.results) {
      if (result.status === 'ready') {
        attempt.saved.add(result.outputPath);
        attempt.pending.delete(result.outputPath);
      } else {
        attempt.pending.add(result.outputPath);
      }
    }
    state.exportAttempt = attempt.pending.size ? attempt : null;
    const message = `${ready.length}/${selectedClips.length} shorts exported` +
      (failures.length ? ` • ${failures.length} failed` : '') +
      (cancelled ? ` • ${cancelled} cancelled` : '');
    showBatchStatus('exportStatus', message, failures);
    toast(message, failures.length ? 'err' : cancelled ? '' : 'ok');
    if (ready.length) api.openPath(dest);
  } catch (err) {
    showBatchStatus('exportStatus', `Export failed. ${err.message}`);
    toast(`Download failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
  }
}

/* ---------------- settings modal ---------------- */
function openSettings() {
  $('settingsModal').classList.remove('hidden');
  if (state.settings.hasApiKey && (!state.models || !state.models.length)) loadModels();
}
function closeSettings() { $('settingsModal').classList.add('hidden'); }

/* ---------------- wire up ---------------- */
function wire() {
  $('addVideoBtn').addEventListener('click', addVideo);
  $('openProjectBtn').addEventListener('click', openProject);
  $('saveProjectBtn').addEventListener('click', saveProject);
  $('dropzone').addEventListener('click', addVideo);
  $('changeFile').addEventListener('click', () => {
    state.video = null;
    editor.setSource(null);
    resetThumbnails();
    $('dropzone').classList.remove('hidden');
    $('fileCard').classList.add('hidden');
    $('controlsPanel').classList.add('hidden');
    $('resultsPanel').classList.add('hidden');
    $('saveProjectBtn').classList.add('hidden');
    $('pageTitle').textContent = 'Import a video or movie';
    $('pageSub').textContent = 'Drop a recording or browse to choose a video.';
    $('addVideoBtn').focus();
    setStep(1, 1);
  });

  // Drag & drop (Electron exposes the real path via webUtils.getPathForFile in preload)
  const dz = $('dropzone');
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('drag')));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    let p = null;
    try { p = api.getPathForFile(file); } catch (_) { /* ignore */ }
    if (!p) { toast('Could not read dropped file — use Add Video instead.', 'err'); return; }
    try {
      const meta = await api.probeFile(p);
      if (meta && !meta.error) selectVideo(meta);
      else toast('Unsupported or unreadable file.', 'err');
    } catch (_) { toast('Could not read dropped file.', 'err'); }
  });

  $('sceneThreshold').addEventListener('input', (e) => { $('threshVal').textContent = Number(e.target.value).toFixed(2); });
  $('targetLen').addEventListener('change', syncBand);
  $('clipMode').addEventListener('change', (event) => switchMode(event.target.value));
  function outputChanged() {
    const drafts = [state.segments, ...[...state.drafts.values()].map((draft) => draft.segments)];
    for (const clips of drafts) {
      for (const clip of clips) {
        if (!clip.outputPath) continue;
        clip.needsRender = true;
      }
    }
    for (const clip of state.segments) {
      refreshClipCard(clip);
      editor.refreshClip(clip);
    }
    updatePresetButtons();
    updateSelCount();
  }
  for (const id of ['aspectRatio', 'reframeMode', 'audioTrack', 'outputQuality', 'enhance', 'burnTitle', 'burnCaptions']) {
    $(id).addEventListener('change', outputChanged);
  }
  $('presetHudSafe').addEventListener('click', () => {
    if ($('aspectRatio').value === '9:16' && $('reframeMode').value === 'blur') return;
    $('aspectRatio').value = '9:16';
    $('reframeMode').value = 'blur';
    outputChanged();
  });
  $('presetOriginal').addEventListener('click', () => {
    if ($('aspectRatio').value === 'original') return;
    $('aspectRatio').value = 'original';
    outputChanged();
  });

  $('analyzeBtn').addEventListener('click', analyze);
  $('manualMarkBtn').addEventListener('click', focusMarker);
  $('enrichBtn').addEventListener('click', () => enrich());
  $('processBtn').addEventListener('click', () => process());
  $('downloadBtn').addEventListener('click', batchDownload);

  $('selectAll').addEventListener('click', () => { state.segments.forEach((s) => (s.selected = true)); renderClips(); updateSelCount(); });
  $('selectNone').addEventListener('click', () => { state.segments.forEach((s) => (s.selected = false)); renderClips(); updateSelCount(); });
  $('selectTop').addEventListener('click', () => {
    const score = (clip) => clip.viralityScore ?? clip.confidence;
    const ranked = [...state.segments].filter((s) => score(s) != null).sort((a, b) => score(b) - score(a));
    if (!ranked.length) { toast('Run "Enhance with AI" first to score clips.', 'err'); return; }
    const top = new Set(ranked.slice(0, 10).map((s) => s.index));
    state.segments.forEach((s) => (s.selected = top.has(s.index)));
    renderClips(); updateSelCount();
  });

  $('aiToggle').addEventListener('click', async () => {
    setAi(!state.settings.aiEnabled);
    if ($('burnTitle').checked && state.video) outputChanged();
    await api.setSettings({ aiEnabled: state.settings.aiEnabled });
  });
  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('saveSettings').addEventListener('click', async () => { await persistSettings(); closeSettings(); toast('Settings saved', 'ok'); });
  $('shareTranscriptContext').addEventListener('change', updateAiDisclosure);
  $('watchRecordingsBtn').addEventListener('click', startRecordingWatch);
  $('stopWatchingBtn').addEventListener('click', stopRecordingWatch);
  api.onRecordingAvailable?.(recordingAvailable);
  $('orLink').addEventListener('click', () => api.openExternal('https://openrouter.ai/keys'));

  $('saveKey').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    const r = await api.setApiKey(key);
    if (r.ok) {
      state.settings.hasApiKey = !!key;
      $('keyStatus').textContent = key ? 'Key saved ✓' : 'Key cleared';
      $('keyStatus').className = 'key-status ok';
      $('apiKey').value = '';
      if (key) loadModels();
    } else { $('keyStatus').textContent = 'Failed to save key'; $('keyStatus').className = 'key-status err'; }
  });
  $('testKey').addEventListener('click', async () => {
    $('keyStatus').textContent = 'Testing…'; $('keyStatus').className = 'key-status';
    try {
      const r = await api.testKey();
      $('keyStatus').textContent = `Connection OK (${r.reply || 'ready'})`;
      $('keyStatus').className = 'key-status ok';
      loadModels();
    } catch (err) { $('keyStatus').textContent = `Failed: ${err.message}`; $('keyStatus').className = 'key-status err'; }
  });
  $('loadModels').addEventListener('click', loadModels);
  // Apply a "cheapest" recommendation when its link is clicked.
  $('settingsModal').addEventListener('click', (e) => {
    const a = e.target.closest('[data-pick]');
    if (!a) return;
    e.preventDefault();
    const sel = a.closest('.field').querySelector('select');
    if (sel) ensureOption(sel, a.dataset.pick);
  });

  $('cancelBtn').addEventListener('click', async () => {
    if (!state.jobId || state.cancelRequested) return;
    const jobId = state.jobId;
    state.cancelRequested = true;
    $('cancelBtn').disabled = true;
    $('progMsg').textContent = 'Cancelling…';
    try {
      await api.cancel(jobId);
    } catch (err) {
      if (state.jobId !== jobId) return;
      state.cancelRequested = false;
      $('cancelBtn').disabled = false;
      $('progMsg').textContent = `Could not cancel. ${err.message}`;
    }
  });
}

function syncBand() {
  const t = Number($('targetLen').value);
  if (Number($('minLen').value) > t) $('minLen').value = Math.max(2, t - 10);
  if (Number($('maxLen').value) < t) $('maxLen').value = t + 20;
}

async function init() {
  wire();
  await loadSettings();
  setStep(1, 1);
  try {
    const hw = await api.detectHw();
    $('hwBadge').textContent = `encoder: ${hw.best.toUpperCase()}${hw.available.length > 1 ? ` (+${hw.available.length - 1})` : ''}`;
  } catch (_) { $('hwBadge').textContent = 'encoder: CPU'; }
}

init();

})();
