const {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  clipboard,
  ipcMain,
  nativeImage,
} = require('electron');
const path = require('path');
const Store = require('electron-store'); // v8 CJS is fine

// ---------------- Stores ----------------
const settingsStore = new Store({
  name: 'settings',
  defaults: {
    hotkey: 'CommandOrControl+Shift+Space',
    maxItems: 500,
    captureContext: false, // optional, usually off
    theme: 'light',
  },
});

const historyStore = new Store({
  name: 'history',
  defaults: { items: [] },
});

// ---------------- State ----------------
let overlayWin = null;
let clipboardPollTimer = null;
let lastClipboardText = '';
let activeWinGetter = null; // lazy-loaded if captureContext = true

async function maybeLoadActiveWin() {
  if (!settingsStore.get('captureContext')) return null;
  if (activeWinGetter) return activeWinGetter;
  try {
    const mod = await import('active-win');
    activeWinGetter = mod.default;
  } catch (e) {
    console.warn('active-win unavailable; disabling captureContext:', e?.message);
    settingsStore.set('captureContext', false);
  }
  return activeWinGetter;
}

// ---------------- Overlay ----------------
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
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWin.on('closed', () => { overlayWin = null; });
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

// ---------------- Hotkey ----------------
function registerHotkey() {
  const hk = (settingsStore.get('hotkey') || 'CommandOrControl+Shift+Space').trim();
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hk, () => showOverlay());
  if (!ok) {
    // fallback
    globalShortcut.register('CommandOrControl+Shift+Space', () => showOverlay());
  }
}

// ---------------- Clipboard polling ----------------
function startClipboardPolling() {
  if (clipboardPollTimer) clearInterval(clipboardPollTimer);

  clipboardPollTimer = setInterval(async () => {
    const text = clipboard.readText();
    if (!text || !text.trim()) return;
    if (text === lastClipboardText) return;
    lastClipboardText = text;

    let source = null;
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

    // de-dupe newest text
    if (items.length && items[0].text === text) return;

    items.unshift({
      id: Date.now(),
      text,
      source,
      pinned: false,
      ts: new Date().toISOString(),
    });

    // pinned first, then newest
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

// ---------------- IPC: history ----------------
ipcMain.handle('history:get', () => historyStore.get('items') || []);
ipcMain.handle('history:clear', () => {
  historyStore.set('items', []);
  return true;
});
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
  const items = historyStore.get('items') || [];
  const filtered = items.filter(i => i.id !== id);
  historyStore.set('items', filtered);
  if (overlayWin && overlayWin.isVisible()) {
    overlayWin.webContents.send('history:update', filtered);
  }
  return true;
});

// ---------------- IPC: settings ----------------
ipcMain.handle('settings:get', () => ({
  hotkey: settingsStore.get('hotkey'),
  maxItems: settingsStore.get('maxItems'),
  captureContext: settingsStore.get('captureContext'),
  theme: settingsStore.get('theme'),
}));
ipcMain.handle('settings:save', (_e, s) => {
  settingsStore.set('hotkey', s.hotkey || 'CommandOrControl+Shift+Space');
  settingsStore.set('maxItems', Math.max(50, Math.min(5000, parseInt(s.maxItems || 500, 10))));
  settingsStore.set('captureContext', !!s.captureContext);
  settingsStore.set('theme', s.theme || 'light');
  registerHotkey();
  return true;
});

// ---------------- IPC: clipboard ----------------
ipcMain.handle('clipboard:set', (_e, data) => {
  if (data?.text) clipboard.writeText(data.text);
  return true;
});

// ---------------- App lifecycle ----------------
app.whenReady().then(() => {
  createOverlay();
  registerHotkey();
  startClipboardPolling();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
