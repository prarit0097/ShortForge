'use strict';

/**
 * Secure bridge between renderer and main. Only a whitelisted, typed API surface is
 * exposed — no raw ipcRenderer, no Node access in the renderer.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  // File / folder pickers
  pickVideos: () => invoke('dialog:pickVideos'),
  pickFolder: () => invoke('dialog:pickFolder'),
  probeFile: (path) => invoke('probe:file', path),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Settings + AI config
  getSettings: () => invoke('settings:get'),
  setSettings: (partial) => invoke('settings:set', partial),
  setApiKey: (key) => invoke('settings:setApiKey', key),
  testKey: () => invoke('ai:testKey'),
  listModels: () => invoke('ai:listModels'),

  // Hardware
  detectHw: () => invoke('hw:detect'),

  // Pipeline
  analyze: (payload) => invoke('analyze:run', payload),
  enrich: (payload) => invoke('ai:enrich', payload),
  process: (payload) => invoke('process:run', payload),
  exportClips: (payload) => invoke('export:batch', payload),
  cancel: (jobId) => invoke('job:cancel', jobId),

  // Shell helpers
  openPath: (p) => invoke('shell:openPath', p),
  openExternal: (url) => invoke('shell:openExternal', url),
  showItem: (p) => invoke('shell:showItem', p),
  toFileUrl: (p) => invoke('util:fileUrl', p),

  // Progress stream. Returns an unsubscribe function.
  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
});
