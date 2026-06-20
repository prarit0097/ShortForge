'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');
const { registerIpc } = require('./ipc');

// Quieter GPU logs on some Windows setups.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0e1116',
    show: false,
    title: 'ShortForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // we only use the preload bridge; services run in main
    },
  });

  mainWindow.removeMenu();

  if (process.env.SF_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on('preload-error', (_e, p, err) => {
      console.log('[preload-error]', p, err && err.stack);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log('[did-fail-load]', code, desc, url);
    });
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  registerIpc(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
