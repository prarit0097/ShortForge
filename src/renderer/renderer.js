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
  clips: [],
  models: [],
  jobId: null,
  enriched: false,
};

let unsubProgress = null;

/* ---------------- helpers ---------------- */
function fileUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '');
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
  $('burnCaptions').checked = !!s.burnCaptions;
  $('burnTitle').checked = s.burnTitle !== false;
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
  $('aiState').textContent = on ? 'ON' : 'OFF';
  $('enrichBtn').classList.toggle('hidden', !on);
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
    aspectRatio: $('aspectRatio').value,
    reframeMode: $('reframeMode').value,
    burnCaptions: $('burnCaptions').checked,
    burnTitle: $('burnTitle').checked,
    aiEnabled: state.settings.aiEnabled,
    aiModelVision: $('aiModelVision').value.trim() || state.settings.aiModelVision,
    aiModelText: $('aiModelText').value.trim() || state.settings.aiModelText,
    whisperModel: $('whisperModel').value,
    hwAccel: $('hwAccel').value,
    exportConcurrency: Number($('exportConcurrency').value),
    useTranscript: true,
  };
}
async function persistSettings() {
  const s = gatherSettings();
  await api.setSettings(s);
  state.settings = { ...state.settings, ...s };
}

/* ---------------- progress overlay ---------------- */
function showProgress(title) {
  $('progTitle').textContent = title;
  $('barFill').style.width = '0%';
  $('progMsg').textContent = 'Starting…';
  $('progressOverlay').classList.remove('hidden');
}
function hideProgress() { $('progressOverlay').classList.add('hidden'); }

api.onProgress((d) => {
  if (d.jobId !== state.jobId) return;
  $('barFill').style.width = `${d.percent}%`;
  $('progMsg').textContent = d.message || '';
});

/* ---------------- import ---------------- */
async function addVideo() {
  const files = await api.pickVideos();
  if (!files || !files.length) return;
  const f = files[0];
  if (f.error) { toast(`Could not read file: ${f.error}`, 'err'); return; }
  selectVideo(f);
}
function selectVideo(meta) {
  state.video = meta;
  state.segments = [];
  state.clips = [];
  state.enriched = false;

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
  $('resultsPanel').classList.add('hidden');
  $('pageTitle').textContent = meta.name;
  $('pageSub').textContent = 'Set your cutting options, then analyze to preview the shorts.';
  setStep(2, 2);
}

/* ---------------- analyze ---------------- */
async function analyze() {
  if (!state.video) return;
  await persistSettings();
  const jobId = newJobId();
  showProgress('Analyzing video');
  try {
    const res = await api.analyze({ filePath: state.video.path, settings: gatherSettings(), jobId });
    if (res.cancelled) { hideProgress(); return; }
    state.segments = res.segments;
    state.enriched = false;
    renderResults(res);
    setStep(3, 3);
    toast(`${res.shortsCount} shorts planned from ${res.sceneCount} scene changes`, 'ok');
  } catch (err) {
    toast(`Analyze failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
  }
}

function renderResults(res) {
  $('resultsPanel').classList.remove('hidden');
  const totalDur = state.video.duration;
  $('summary').innerHTML = `
    <div class="big-num">${state.segments.length} shorts</div>
    <div class="meta">from ${fmtDuration(totalDur)} • ${res ? res.sceneCount : '—'} scene changes •
      full coverage, nothing skipped</div>`;
  $('downloadBtn').classList.add('hidden');
  $('processBtn').classList.remove('hidden');
  renderClips();
  updateSelCount();
  $('resultsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scoreClass(v) {
  if (v == null) return '';
  if (v >= 70) return 'score-hi';
  if (v >= 45) return 'score-mid';
  return 'score-lo';
}

function renderClips() {
  const grid = $('clipGrid');
  grid.innerHTML = '';
  state.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'clip-card' + (seg.selected ? ' selected' : '');
    const media = seg.outputPath
      ? `<video class="clip-vid" src="${fileUrl(seg.outputPath)}" muted preload="metadata"></video>`
      : seg.thumbPath
        ? `<img src="${fileUrl(seg.thumbPath)}" loading="lazy" />`
        : '';
    const score = seg.viralityScore != null
      ? `<div class="clip-score ${scoreClass(seg.viralityScore)}">🔥 ${seg.viralityScore}</div>` : '';
    const tags = (seg.hashtags && seg.hashtags.length)
      ? `<div class="clip-tags">${seg.hashtags.slice(0, 3).map((t) => `<span>${t}</span>`).join('')}</div>` : '';

    card.innerHTML = `
      <div class="clip-thumb">
        ${media}
        <div class="clip-check" data-i="${i}">✓</div>
        <div class="clip-dur">${seg.duration.toFixed(1)}s</div>
        ${score}
      </div>
      <div class="clip-body">
        <input class="clip-title" data-i="${i}" value="${(seg.title || `Short ${i + 1}`).replace(/"/g, '&quot;')}" />
        <div class="clip-range">${fmtClock(seg.start)} → ${fmtClock(seg.end)}</div>
        ${tags}
        ${seg.outputPath ? `<div class="clip-actions">
            <button data-act="play" data-i="${i}">▶ Open</button>
            <button data-act="reveal" data-i="${i}">📂 Folder</button>
          </div>` : ''}
      </div>`;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.clip-check').forEach((el) =>
    el.addEventListener('click', () => toggleSelect(Number(el.dataset.i))));
  grid.querySelectorAll('.clip-title').forEach((el) =>
    el.addEventListener('change', () => { state.segments[Number(el.dataset.i)].title = el.value; }));
  grid.querySelectorAll('[data-act]').forEach((el) =>
    el.addEventListener('click', () => {
      const seg = state.segments[Number(el.dataset.i)];
      if (el.dataset.act === 'play') api.openPath(seg.outputPath);
      else api.showItem(seg.outputPath);
    }));
  // Hover-to-preview (CSP-safe, no inline handlers).
  grid.querySelectorAll('.clip-vid').forEach((v) => {
    v.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
    v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
  });
}
function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function toggleSelect(i) {
  state.segments[i].selected = !state.segments[i].selected;
  renderClips();
  updateSelCount();
}
function updateSelCount() {
  const n = state.segments.filter((s) => s.selected).length;
  $('selCount').textContent = n;
}

/* ---------------- AI enrich ---------------- */
async function enrich() {
  if (!state.settings.aiEnabled) { toast('Turn the AI Layer ON first.', 'err'); return; }
  if (!state.settings.hasApiKey) { toast('Add your OpenRouter API key in Settings.', 'err'); openSettings(); return; }
  await persistSettings();
  const jobId = newJobId();
  showProgress('Enhancing with AI');
  try {
    const res = await api.enrich({ filePath: state.video.path, segments: state.segments, settings: gatherSettings(), jobId });
    if (res.cancelled) { hideProgress(); return; }
    state.segments = res.segments;
    state.enriched = true;
    renderClips();
    toast('AI analysis done — titles, scores & smart crop ready', 'ok');
  } catch (err) {
    toast(`AI enhance failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
  }
}

/* ---------------- process ---------------- */
async function process() {
  let selected = state.segments.filter((s) => s.selected);
  if (!selected.length) { toast('Select at least one short.', 'err'); return; }

  // If the AI layer is on but clips haven't been enhanced yet, do it now so the AI
  // titles/scores/crop actually drive the output (otherwise AI-on == AI-off).
  if (state.settings.aiEnabled && !state.enriched) {
    if (!state.settings.hasApiKey) {
      toast('AI Layer is ON but no API key set. Add it in Settings, or turn AI off.', 'err');
      openSettings();
      return;
    }
    await enrich();
    if (!state.enriched) return; // enrichment failed/cancelled; abort processing
    selected = state.segments.filter((s) => s.selected);
  }

  await persistSettings();
  const jobId = newJobId();
  showProgress(`Cutting ${selected.length} shorts`);
  try {
    const res = await api.process({ filePath: state.video.path, segments: selected, settings: gatherSettings(), jobId });
    if (res.cancelled) { hideProgress(); return; }
    // Merge output paths back into segments.
    const byIndex = new Map(res.clips.map((c) => [c.index, c]));
    state.segments = state.segments.map((s) => (byIndex.has(s.index) ? { ...s, ...byIndex.get(s.index) } : s));
    state.clips = res.clips;
    renderClips();
    $('processBtn').classList.add('hidden');
    $('downloadBtn').classList.remove('hidden');
    setStep(5, 5);
    toast(`${res.clips.length} shorts ready — hover to preview, then download`, 'ok');
  } catch (err) {
    toast(`Processing failed: ${err.message}`, 'err');
  } finally {
    hideProgress();
  }
}

/* ---------------- export ---------------- */
async function batchDownload() {
  const selectedClips = state.segments.filter((s) => s.selected && s.outputPath);
  if (!selectedClips.length) { toast('Select processed shorts to download.', 'err'); return; }
  const dest = await api.pickFolder();
  if (!dest) return;
  const jobId = newJobId();
  showProgress(`Downloading ${selectedClips.length} shorts`);
  try {
    const res = await api.exportClips({
      clips: selectedClips.map((s) => ({ outputPath: s.outputPath, fileName: s.fileName })),
      destDir: dest, settings: gatherSettings(), jobId,
    });
    const ok = res.results.filter((r) => r.ok).length;
    toast(`Downloaded ${ok}/${res.results.length} shorts to your folder`, 'ok');
    api.openPath(dest);
  } catch (err) {
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
  $('dropzone').addEventListener('click', addVideo);
  $('changeFile').addEventListener('click', () => {
    $('dropzone').classList.remove('hidden');
    $('fileCard').classList.add('hidden');
    $('controlsPanel').classList.add('hidden');
    $('resultsPanel').classList.add('hidden');
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

  $('analyzeBtn').addEventListener('click', analyze);
  $('enrichBtn').addEventListener('click', enrich);
  $('processBtn').addEventListener('click', process);
  $('downloadBtn').addEventListener('click', batchDownload);

  $('selectAll').addEventListener('click', () => { state.segments.forEach((s) => (s.selected = true)); renderClips(); updateSelCount(); });
  $('selectNone').addEventListener('click', () => { state.segments.forEach((s) => (s.selected = false)); renderClips(); updateSelCount(); });
  $('selectTop').addEventListener('click', () => {
    const ranked = [...state.segments].filter((s) => s.viralityScore != null).sort((a, b) => b.viralityScore - a.viralityScore);
    if (!ranked.length) { toast('Run "Enhance with AI" first to score clips.', 'err'); return; }
    const top = new Set(ranked.slice(0, 10).map((s) => s.index));
    state.segments.forEach((s) => (s.selected = top.has(s.index)));
    renderClips(); updateSelCount();
  });

  $('aiToggle').addEventListener('click', async () => { setAi(!state.settings.aiEnabled); await api.setSettings({ aiEnabled: state.settings.aiEnabled }); });
  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('saveSettings').addEventListener('click', async () => { await persistSettings(); closeSettings(); toast('Settings saved', 'ok'); });
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

  $('cancelBtn').addEventListener('click', async () => { if (state.jobId) await api.cancel(state.jobId); hideProgress(); toast('Cancelled', ''); });
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
