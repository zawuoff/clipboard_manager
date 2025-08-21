// main.js
const {
  app,
  BrowserWindow,
  globalShortcut,
  clipboard,
  ipcMain,
  nativeImage,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const Store = require('electron-store');

/* ========= Dev-only live reload ========= */
if (process.env.NODE_ENV !== 'production') {
  try {
    require('electron-reload')(__dirname);
  } catch (e) {
    console.warn('[dev] electron-reload not installed:', e?.message);
  }
}

/* ========= Stores ========= */
const settingsStore = new Store({
  name: 'settings',
  defaults: {
    hotkey: 'CommandOrControl+Shift+Space',
    maxItems: 500,
    captureContext: false,
    theme: 'light',
    searchMode: 'fuzzy',   // fuzzy | exact
    fuzzyThreshold: 0.5,   // 0.2 strict … 0.7 loose
  },
});

const historyStore = new Store({
  name: 'history',
  // item:
  //  - Text:  {id, type:'text',  text,  pinned, ts, source?}
  //  - Image: {id, type:'image', filePath, thumb, wh:{w,h}, pinned, ts, source?}
  defaults: { items: [] },
});

/* ========= State ========= */
let overlayWin = null;
let clipboardPollTimer = null;
let lastClipboardText = '';
let lastImageHash = '';
let activeWinGetter = null; // lazy import when captureContext=true

/* ========= Helpers ========= */
function userDir(...p) {
  return path.join(app.getPath('userData'), ...p);
}
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Save full PNG + thumbnail dataURL; return {filePath, thumb, wh} */
async function persistImage(nimg, id) {
  const outDir = userDir('clips', 'imgs');
  await ensureDir(outDir);

  const png = nimg.toPNG();
  const filePath = path.join(outDir, `${id}.png`);
  await fsp.writeFile(filePath, png);

  const sz = nimg.getSize();
  const targetW = Math.min(320, Math.max(64, sz.width));
  const thumbImg = nimg.resize({ width: targetW, quality: 'best' });
  const thumb = 'data:image/png;base64,' + thumbImg.toPNG().toString('base64');

  return { filePath, thumb, wh: { w: sz.width, h: sz.height } };
}

/** More tolerant image read (helps with Win+Shift+S / Snipping Tool) */
function readClipboardImageRobust() {
  // 1) Normal path (Electron will convert CF_DIB etc. when it can)
  let img = clipboard.readImage();
  if (img && !img.isEmpty()) return img;

  // 2) Windows sometimes exposes non-MIME format names. Try them all.
  const fmts = clipboard.availableFormats();
  const imageLike = fmts.filter(f => /image|png|jpg|jpeg|bmp|dib|bitmap|jfif/i.test(f));
  if (imageLike.length) {
    console.log('[clip] image-like formats on clipboard:', fmts);
  }

  // Common MIME + Win custom names
  const tryFormats = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/bmp',
    'PNG', 'JFIF', 'Bitmap', 'CF_DIB', 'DeviceIndependentBitmap'
  ];

  for (const fmt of tryFormats) {
    if (!fmts.includes(fmt)) continue;
    try {
      const buf = clipboard.readBuffer(fmt);
      if (buf && buf.length) {
        const ni = nativeImage.createFromBuffer(buf);
        if (ni && !ni.isEmpty()) return ni;
      }
    } catch (e) {
      console.warn('[clip] readBuffer failed for', fmt, e?.message);
    }
  }
  return null;
}


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

// pinned first → newest
function sortItems(items) {
  items.sort(
    (a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
      new Date(b.ts) - new Date(a.ts)
  );
}

// Trim to max and delete overflow image files
function enforceMaxAndCleanup(items) {
  const max = settingsStore.get('maxItems') || 500;
  if (items.length <= max) return;
  const removed = items.splice(max);
  removed.forEach(async it => {
    if (it.type === 'image' && it.filePath) {
      try { await fsp.unlink(it.filePath); } catch {}
    }
  });
}

/* ========= Overlay window ========= */
function createOverlay() {
  if (overlayWin) return overlayWin;

  overlayWin = new BrowserWindow({
    width: 900,
    height: 560,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false, // no OS halo; CSS handles visual shadow
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false, // preload needs require() for Fuse
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

/* ========= Hotkey ========= */
function registerHotkey() {
  const hk = (settingsStore.get('hotkey') || 'CommandOrControl+Shift+Space').trim();
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hk, showOverlay);
  if (!ok) {
    const fb = 'CommandOrControl+Shift+Space';
    globalShortcut.register(fb, showOverlay);
  }
}

/* ========= Polling (text + images) ========= */
function startClipboardPolling() {
  if (clipboardPollTimer) clearInterval(clipboardPollTimer);

  clipboardPollTimer = setInterval(async () => {
    // ---- 1) Images first ----
    try {
      const img = readClipboardImageRobust();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        const hash = sha1(png);
        if (hash !== lastImageHash) {
          lastImageHash = hash;
           //console.log('[clip] image formats:', clipboard.availableFormats());

          // (optional) context
          let source;
          if (settingsStore.get('captureContext')) {
            try {
              const getWin = await maybeLoadActiveWin();
              if (getWin) {
                const info = await getWin();
                if (info) source = { title: info.title, app: info.owner?.name };
              }
            } catch {}
          }

          const id = Date.now();
          let filePath, thumb, wh;
          try {
            ({ filePath, thumb, wh } = await persistImage(img, id));
          } catch (e) {
            console.warn('[clip] persistImage failed:', e?.message);
            return;
          }

          const items = historyStore.get('items') || [];
          items.unshift({
            id,
            type: 'image',
            filePath,
            thumb,
            wh,
            pinned: false,
            ts: new Date().toISOString(),
            source,
          });

          sortItems(items);
          enforceMaxAndCleanup(items);
          historyStore.set('items', items);
          if (overlayWin && overlayWin.isVisible()) {
            overlayWin.webContents.send('history:update', items);
          }
          return; // handled this tick; skip text
        }
      }
    } catch (e) {
      console.warn('[clip] image read error:', e?.message);
    }

    // ---- 2) Text ----
    const text = clipboard.readText();
    if (!text || !text.trim()) return;
    if (text === lastClipboardText) return;
    lastClipboardText = text;

    let source;
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
    if (items.length && items[0].type === 'text' && items[0].text === text) return;

    items.unshift({
      id: Date.now(),
      type: 'text',
      text,
      pinned: false,
      ts: new Date().toISOString(),
      source,
    });

    sortItems(items);
    enforceMaxAndCleanup(items);
    historyStore.set('items', items);
    if (overlayWin && overlayWin.isVisible()) {
      overlayWin.webContents.send('history:update', items);
    }
  }, 700);
}

/* ========= IPC: History ========= */
ipcMain.handle('history:get', () => historyStore.get('items') || []);

ipcMain.handle('history:clear', async () => {
  const items = historyStore.get('items') || [];
  for (const it of items) {
    if (it.type === 'image' && it.filePath) {
      try { await fsp.unlink(it.filePath); } catch {}
    }
  }
  historyStore.set('items', []);
  return true;
});

ipcMain.handle('history:updateItem', async (_e, { id, patch }) => {
  const items = historyStore.get('items') || [];
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...patch };
    sortItems(items);
    historyStore.set('items', items);
    if (overlayWin && overlayWin.isVisible()) {
      overlayWin.webContents.send('history:update', items);
    }
  }
  return true;
});

ipcMain.handle('delete-history-item', async (_e, id) => {
  const items = historyStore.get('items') || [];
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0) {
    const it = items[idx];
    if (it.type === 'image' && it.filePath) {
      try { await fsp.unlink(it.filePath); } catch {}
    }
  }
  const filtered = items.filter(i => i.id !== id);
  historyStore.set('items', filtered);
  if (overlayWin && overlayWin.isVisible()) {
    overlayWin.webContents.send('history:update', filtered);
  }
  return true;
});

ipcMain.handle('open-url', async (_event, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    console.error('Failed to open URL:', error);
    return false;
  }
});



/* ========= IPC: Settings ========= */
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
  settingsStore.set(
    'maxItems',
    Math.max(50, Math.min(5000, parseInt(s.maxItems || 500, 10)))
  );
  settingsStore.set('captureContext', !!s.captureContext);
  settingsStore.set('theme', s.theme || 'light');
  settingsStore.set('searchMode', s.searchMode === 'exact' ? 'exact' : 'fuzzy');
  const th = Number.isFinite(+s.fuzzyThreshold)
    ? Math.min(0.9, Math.max(0.1, +s.fuzzyThreshold))
    : 0.5;
  settingsStore.set('fuzzyThreshold', th);

  registerHotkey();
  return true;
});

/* ========= IPC: Clipboard set ========= */
ipcMain.handle('clipboard:set', (_e, data) => {
  if (data?.text) {
    clipboard.writeText(String(data.text));
    return true;
  }
  if (data?.imagePath) {
    try {
      const img = nativeImage.createFromPath(data.imagePath);
      if (!img.isEmpty()) clipboard.writeImage(img);
    } catch {}
    return true;
  }
  if (data?.imageDataUrl) {
    try {
      const img = nativeImage.createFromDataURL(data.imageDataUrl);
      if (!img.isEmpty()) clipboard.writeImage(img);
    } catch {}
    return true;
  }
  return false;
});

/* ========= Lifecycle ========= */
app.setAppUserModelId('clip-overlay');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showOverlay());

  app.whenReady().then(() => {
    console.log('[clip] images dir:', userDir('clips', 'imgs'));
    createOverlay();
    registerHotkey();
    startClipboardPolling();   // <-- start the clip watcher
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
