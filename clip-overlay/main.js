const {
  app,
  BrowserWindow,
  globalShortcut,
  clipboard,
  ipcMain,
} = require('electron');
const path = require('path');
const Store = require('electron-store');

// only for dev purposes for testing live changes
//paste after the requires and before the stores
if (process.env.NODE_ENV !== 'production') {
  require('electron-reload')(__dirname);
}

const settingsStore = new Store({
  name: 'settings',
  defaults: {
    hotkey: 'CommandOrControl+Shift+Space',
    maxItems: 500,
    captureContext: false,
    theme: 'light',
    searchMode: 'fuzzy',       // NEW
    fuzzyThreshold: 0.5,       // NEW (0.2 strict … 0.7 loose)
  },
});

const historyStore = new Store({
  name: 'history',
  defaults: { items: [] },
});

let overlayWin = null;
let clipboardPollTimer = null;
let lastClipboardText = '';
let activeWinGetter = null;

async function maybeLoadActiveWin() {
  if (!settingsStore.get('captureContext')) return null;
  if (activeWinGetter) return activeWinGetter;
  try {
    const mod = await import('active-win');
    activeWinGetter = mod.default;
  } catch {
    settingsStore.set('captureContext', false);
  }
  return activeWinGetter;
}

function createOverlay() {
  if (overlayWin) return overlayWin;

  overlayWin = new BrowserWindow({
    width: 720,
    height: 520,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false, // keep preload Node available
    },
  });

  overlayWin.on('closed', () => { overlayWin = null; });
  overlayWin.on('blur', () => { if (overlayWin) overlayWin.hide(); });
  overlayWin.loadFile('overlay.html');
  return overlayWin;
}

function showOverlay() {
  const win = createOverlay();
  if (!win) return;
  if (!win.isVisible()) win.showInactive();
  win.focus();
  win.webContents.send('overlay:show');
  win.webContents.send('overlay:anim', true);
}

ipcMain.handle('overlay:hide', () => {
  if (!overlayWin) return;
  overlayWin.webContents.send('overlay:anim', false);
  overlayWin.hide();
});

function registerHotkey() {
  const hk = (settingsStore.get('hotkey') || 'CommandOrControl+Shift+Space').trim();
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hk, () => showOverlay());
  if (!ok) {
    globalShortcut.register('CommandOrControl+Shift+Space', () => showOverlay());
  }
}

function startClipboardPolling() {
  if (clipboardPollTimer) clearInterval(clipboardPollTimer);

  clipboardPollTimer = setInterval(async () => {
    const text = clipboard.readText();
    if (!text || !text.trim()) return;
    if (text === lastClipboardText) return;
    lastClipboardText = text;

    let source = undefined;
    if (settingsStore.get('captureContext')) {
      try {
        const getWin = await maybeLoadActiveWin();
        if (getWin) {
          const info = await getWin();
          if (info) source = { title: info.title, app: info.owner?.name };
        }
      } catch {}
    }

    const items = historyStore.get('items') || [];
    if (items.length && items[0].text === text) return;

    items.unshift({
      id: Date.now(),
      text,
      source,
      pinned: false,
      ts: new Date().toISOString(),
    });

    items.sort(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
        new Date(b.ts) - new Date(a.ts)
    );

    const max = settingsStore.get('maxItems') || 500;
    if (items.length > max) items.length = max;

    historyStore.set('items', items);
    if (overlayWin && overlayWin.isVisible()) {
      overlayWin.webContents.send('history:update', items);
    }
  }, 700);
}

// IPC: history
ipcMain.handle('history:get', () => historyStore.get('items') || []);
ipcMain.handle('history:clear', () => { historyStore.set('items', []); return true; });
ipcMain.handle('history:updateItem', (_e, { id, patch }) => {
  const items = historyStore.get('items') || [];
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...patch };
    items.sort(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
        new Date(b.ts) - new Date(a.ts)
    );
    historyStore.set('items', items);
    if (overlayWin && overlayWin.isVisible()) {
      overlayWin.webContents.send('history:update', items);
    }
  }
  return true;
});
ipcMain.handle('delete-history-item', (_e, id) => {
  const items = (historyStore.get('items') || []).filter(i => i.id !== id);
  historyStore.set('items', items);
  if (overlayWin && overlayWin.isVisible()) {
    overlayWin.webContents.send('history:update', items);
  }
  return true;
});

// IPC: settings
ipcMain.handle('settings:get', () => ({
  hotkey: settingsStore.get('hotkey'),
  maxItems: settingsStore.get('maxItems'),
  captureContext: settingsStore.get('captureContext'),
  theme: settingsStore.get('theme'),
  searchMode: settingsStore.get('searchMode'),
  fuzzyThreshold: settingsStore.get('fuzzyThreshold'),
}));
ipcMain.handle('settings:save', (_e, s) => {
  settingsStore.set('hotkey', s.hotkey || 'CommandOrControl+Shift+Space');
  settingsStore.set('maxItems', Math.max(50, Math.min(5000, parseInt(s.maxItems || 500, 10))));
  settingsStore.set('captureContext', !!s.captureContext);
  settingsStore.set('theme', s.theme || 'light');
  settingsStore.set('searchMode', s.searchMode === 'exact' ? 'exact' : 'fuzzy');
  const th = Number.isFinite(+s.fuzzyThreshold) ? Math.min(0.9, Math.max(0.1, +s.fuzzyThreshold)) : 0.5;
  settingsStore.set('fuzzyThreshold', th);
  registerHotkey();
  return true;
});

// IPC: clipboard
ipcMain.handle('clipboard:set', (_e, data) => { if (data?.text) clipboard.writeText(data.text); return true; });

// Lifecycle
app.setAppUserModelId('clip-overlay');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showOverlay());
  app.whenReady().then(() => { createOverlay(); registerHotkey(); startClipboardPolling(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
