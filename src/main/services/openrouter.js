'use strict';

/**
 * OpenRouter AI layer. All calls happen in the main process so the API key never
 * touches the renderer. Provides: connection test, model listing, and per-segment
 * enrichment (scene understanding + virality score + title/caption/hashtags +
 * smart-crop hint) using a single vision call per clip to keep cost low.
 */

const BASE = 'https://openrouter.ai/api/v1';
const HEADERS = (key) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://shortforge.app',
  'X-Title': 'ShortForge',
});

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  // Common case: the model returned bare JSON exactly as instructed.
  try {
    return JSON.parse(cleaned);
  } catch (_) { /* fall through to brace-range slice */ }
  // Fallback: grab the first {...last } block (handles trailing prose).
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.warn('[openrouter] extractJson: no JSON object found:', cleaned.slice(0, 160));
    return null;
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    console.warn('[openrouter] extractJson: parse failed:', err.message, '| raw:', cleaned.slice(0, 160));
    return null;
  }
}

/**
 * fetch + parse JSON under a single AbortController timeout. The timer is only
 * cleared after the body is fully read, so a server that sends headers and then
 * stalls the body stream still aborts (no indefinite hang).
 */
async function fetchJson(url, options = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`OpenRouter request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(tid);
  }
}

async function chat(key, model, messages, { maxTokens = 700, temperature = 0.7, timeoutMs = 60000 } = {}) {
  const data = await fetchJson(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: HEADERS(key),
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  }, timeoutMs);
  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
}

async function testKey(key, model) {
  if (!key) throw new Error('No API key set.');
  const out = await chat(key, model || 'google/gemini-2.5-flash-lite',
    [{ role: 'user', content: 'Reply with the single word: OK' }], { maxTokens: 5, temperature: 0 });
  return { ok: true, reply: (out || '').trim() };
}

async function listModels(key) {
  const data = await fetchJson(
    `${BASE}/models`,
    { headers: key ? HEADERS(key) : { 'Content-Type': 'application/json' } },
    20000,
  );
  return (data.data || [])
    .map((m) => {
      const p = m.pricing || {};
      const prompt = Number(p.prompt); // USD per token
      const completion = Number(p.completion);
      const arch = m.architecture || {};
      const mods = arch.input_modalities || (arch.modality ? arch.modality.split('->')[0].split('+') : []);
      return {
        id: m.id,
        name: m.name || m.id,
        prompt,
        completion,
        promptPerM: +(prompt * 1e6).toFixed(3),       // $ per million input tokens
        completionPerM: +(completion * 1e6).toFixed(3), // $ per million output tokens
        isVision: Array.isArray(mods) && mods.includes('image'),
        isFree: prompt === 0 && completion === 0,
        contextLength: m.context_length || 0,
      };
    })
    // Drop meta/router models with dynamic (negative) pricing — they pollute the
    // "cheapest" ranking and aren't meaningful single models.
    .filter((m) => Number.isFinite(m.prompt) && Number.isFinite(m.completion) && m.prompt >= 0 && m.completion >= 0)
    .map(({ prompt, completion, ...rest }) => rest);
}

const SYSTEM = `You are a viral short-form video editor. You analyse a single scene from a
longer video and return STRICT JSON only, no prose. Fields:
{"description": "<one sentence of what's happening>",
 "title": "<punchy <=60 char hook title>",
 "caption": "<1-2 sentence social caption>",
 "hashtags": ["#tag1","#tag2","#tag3"],
 "viralityScore": <integer 0-100 how engaging/shareable this clip is>,
 "subjectX": <number -1 to 1, horizontal position of the main subject: -1 left, 0 center, 1 right>,
 "keep": <true if this makes a good standalone short, false if it's filler>}`;

/**
 * Enrich one segment. Sends the thumbnail (vision) plus optional transcript text.
 * @returns object merged onto the segment.
 */
async function enrichSegment(key, models, seg, dataUri, transcriptText) {
  const userContent = [
    {
      type: 'text',
      text:
        `Scene #${seg.index + 1}, length ${seg.duration}s.` +
        (transcriptText ? `\nTranscript: "${transcriptText.slice(0, 800)}"` : '') +
        `\nReturn the JSON described in the system message.`,
    },
  ];
  if (dataUri) userContent.push({ type: 'image_url', image_url: { url: dataUri } });

  const content = await chat(
    key,
    models.vision,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userContent },
    ],
    { maxTokens: 500, temperature: 0.6 }
  );

  const json = extractJson(content) || {};
  return {
    aiDescription: json.description || '',
    title: json.title || `Short ${seg.index + 1}`,
    caption: json.caption || '',
    hashtags: Array.isArray(json.hashtags) ? json.hashtags : [],
    viralityScore: Number.isFinite(json.viralityScore) ? Math.round(json.viralityScore) : null,
    cropBias: Number.isFinite(json.subjectX) ? Math.max(-1, Math.min(1, json.subjectX)) : 0,
    aiKeep: json.keep !== false,
  };
}

module.exports = { testKey, listModels, enrichSegment, chat };
