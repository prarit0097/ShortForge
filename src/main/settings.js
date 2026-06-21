'use strict';

/**
 * Minimal JSON-file settings store in userData. The OpenRouter API key is encrypted
 * at rest with Electron safeStorage (Windows DPAPI). No external dependency needed.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { DEFAULTS } = require('./constants');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const KEY_FILE = () => path.join(app.getPath('userData'), 'openrouter.key');

function load() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

/**
 * One-time migration: move existing installs off the old blurred-pad default to the
 * new full-screen fill. Runs once (guarded by _fsMigration), then never overrides
 * the user's choice again. Fresh installs already default to 'crop'.
 */
function migrate() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch (_) {
    return; // no saved settings yet → defaults apply (crop)
  }
  if (raw._fsMigration) return;
  const next = { ...raw, _fsMigration: true };
  if (!raw.reframeMode || raw.reframeMode === 'blur') next.reframeMode = 'crop';
  try {
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] migrate failed:', err.message);
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  // Never persist the raw key inside settings.json.
  delete next.apiKey;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] save failed:', err.message);
  }
  return next;
}

function setApiKey(plainKey) {
  try {
    if (!plainKey) {
      if (fs.existsSync(KEY_FILE())) fs.unlinkSync(KEY_FILE());
      return true;
    }
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(plainKey)
      : Buffer.from(plainKey, 'utf8');
    fs.writeFileSync(KEY_FILE(), buf);
    return true;
  } catch (err) {
    console.error('[settings] setApiKey failed:', err.message);
    return false;
  }
}

function getApiKey() {
  try {
    if (!fs.existsSync(KEY_FILE())) return '';
    const buf = fs.readFileSync(KEY_FILE());
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf);
      } catch (_) {
        return buf.toString('utf8'); // stored before encryption was available
      }
    }
    return buf.toString('utf8');
  } catch (err) {
    console.error('[settings] getApiKey failed:', err.message);
    return '';
  }
}

function hasApiKey() {
  return !!getApiKey();
}

module.exports = { load, save, migrate, setApiKey, getApiKey, hasApiKey };
