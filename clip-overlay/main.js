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

// === OCR (offline) ===
const { createWorker } = require('tesseract.js');
let ocrWorker; // lazily created

// Find eng.traineddata(.gz) recursively (dev: node_modules; prod: resources/tessdata/eng)
function findEngModelDir(baseDir) {
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (/^eng\.traineddata(\.gz)?$/i.test(e.name)) {
        return { dir: path.dirname(p), gzip: e.name.toLowerCase().endsWith('.gz') };
      }
    }
  }
  return null;
}

function resolveEngDataDir() {
  const devBase  = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  const prodBase = path.join(process.resourcesPath, 'tessdata', 'eng');
  const assetsBase = path.join(__dirname, 'assets', 'tessdata', 'eng'); // optional local fallback

  if (!app.isPackaged) {
    return findEngModelDir(devBase) || findEngModelDir(assetsBase);
  }
  return findEngModelDir(prodBase);
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;

  const found = resolveEngDataDir();
  if (!found) {
    throw new Error('Tesseract ENG model not found. Install @tesseract.js-data/eng or ship assets/tessdata.');
  }

  console.log('[ocr] langDir =', found.dir, ' gzip:', found.gzip);

  // v6 API: pass language to createWorker; no loadLanguage/initialize calls
  ocrWorker = await createWorker('eng', undefined, {
    langPath: found.dir,                                 // folder containing eng.traineddata(.gz)
    gzip: found.gzip,
    cachePath: path.join(app.getPath('userData'), 'tess-cache'),
    workerBlobURL: false,
  });

  return ocrWorker;
}

app.on('will-quit', async () => { try { await ocrWorker?.terminate(); } catch {} });

// === Stores ===
const settingsStore = new Store({
  name: 'settings',
  defaults: {
    hotkey: 'CommandOrControl+Shift+Space',
    maxItems: 500,
    captureContext: false,
    theme: 'light',
    searchMode: 'fuzzy',
    fuzzyThreshold: 0.5,
  },
});

const historyStore = new Store({
  name: 'history',
  //  - Text:  {id, type:'text',  text,  pinned, ts, source?}
  //  - Image: {id, type:'image', filePath, thumb, wh:{w,h}, pinned, ts, source?, ocrText?}
  defaults: { items: [] },
});

// === State ===
let overlayWin = null;
let clipboardPollTimer = null;
let lastClipboardText = '';
let lastImageHash = '';
let activeWinGetter = null; // lazy import when captureContext=true

// === Helpers ===
function userDir(...p) { return path.join(app.getPath('userData'), ...p); }
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

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

// tolerant image read (handles Win+Shift+S)
function readClipboardImageRobust() {
  let img = clipboard.readImage();
  if (img && !img.isEmpty()) return img;

  try {
    const fmts = clipboard.availableFormats();
    const imageLike = fmts.filter(f => /image|png|jpg|jpeg|bmp|dib|bitmap|jfif/i.test(f));
    for (const f of imageLike) {
      const data = clipboard.readBuffer(f);
      if (data && data.length > 0) {
        const nimg = nativeImage.createFromBuffer(data);
        if (nimg && !nimg.isEmpty()) return nimg;
      }
    }
  } catch {}
  return nativeImage.createEmpty();
}

async function maybeLoadActiveWin() {
  if (activeWinGetter) return activeWinGetter;
  try {
    const mod = await import('active-win'); // optional dep
    if (typeof mod.default === 'function') activeWinGetter = mod.default;
  } catch {
    activeWinGetter = null;
  }
  return activeWinGetter;
}

function sortItems(items) {
  items.sort(
    (a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
      new Date(b.ts) - new Date(a.ts)
  );
}

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

// === Overlay window ===
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
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
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

// === Hotkey ===
function registerHotkey() {
  const hk = (settingsStore.get('hotkey') || 'CommandOrControl+Shift+Space').trim();
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hk, showOverlay);
  if (!ok) {
    const fb = 'CommandOrControl+Shift+Space';
    globalShortcut.register(fb, showOverlay);
  }
}

// === Clipboard polling (images + text) ===
function startClipboardPolling() {
  if (clipboardPollTimer) clearInterval(clipboardPollTimer);

  clipboardPollTimer = setInterval(async () => {
    // 1) Images first
    try {
      const img = readClipboardImageRobust();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        const hash = sha1(png);
        if (hash !== lastImageHash) {
          lastImageHash = hash;

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
          const meta = await persistImage(img, id);
          const items = historyStore.get('items') || [];
          items.unshift({ id, type: 'image', pinned: false, ts: new Date().toISOString(), source, ...meta });
          sortItems(items);
          enforceMaxAndCleanup(items);
          historyStore.set('items', items);
          if (overlayWin?.webContents) overlayWin.webContents.send('history:update', items);

          // --- Inline OCR (offline) ---
          (async () => {
            try {
              const worker = await getOcrWorker();
              const { data } = await worker.recognize(meta.filePath);
              const text = (data?.text || '').trim();
              if (!text) return;

              const itemsNow = historyStore.get('items') || [];
              const idx = itemsNow.findIndex(i => i.id === id);
              if (idx >= 0) {
                itemsNow[idx].ocrText = text.length > 12000 ? text.slice(0, 12000) : text;
                historyStore.set('items', itemsNow);
                if (overlayWin?.webContents) overlayWin.webContents.send('history:update', itemsNow);
              }
            } catch (e) {
              console.warn('[ocr]', e?.message);
            }
          })();

          return; // handled this tick; skip text
        }
      }
    } catch (e) {
      console.warn('[clip] image read error:', e?.message);
    }

    // 2) Text
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

    const id = Date.now();
    items.unshift({
      id,
      type: 'text',
      text,
      pinned: false,
      ts: new Date().toISOString(),
      source,
    });
    sortItems(items);
    enforceMaxAndCleanup(items);
    historyStore.set('items', items);
    if (overlayWin?.webContents) overlayWin.webContents.send('history:update', items);
  }, 200);
}

// === IPC: history ===
ipcMain.handle('history:get', () => historyStore.get('items') || []);

ipcMain.handle('history:clear', async () => {
  const items = historyStore.get('items') || [];
  for (const it of items) {
    if (it.type === 'image' && it.filePath) {
      try { await fsp.unlink(it.filePath); } catch {}
    }
  }
  historyStore.set('items', []);
  if (overlayWin?.webContents) overlayWin.webContents.send('history:update', []);
  return true;
});

ipcMain.handle('history:updateItem', (_e, { id, patch }) => {
  const items = historyStore.get('items') || [];
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...patch };
    sortItems(items);
    historyStore.set('items', items);
    if (overlayWin?.webContents) overlayWin.webContents.send('history:update', items);
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
  if (overlayWin?.webContents) overlayWin.webContents.send('history:update', filtered);
  return true;
});

ipcMain.handle('open-url', async (_event, url) => {
  try { await shell.openExternal(url); return true; }
  catch { return false; }
});

// === IPC: settings ===
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

// === IPC: clipboard set ===
ipcMain.handle('clipboard:set', (_e, data) => {
  if (data?.text) { clipboard.writeText(String(data.text)); return true; }
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

// === Lifecycle ===
app.setAppUserModelId('com.fouwaz.snippetstash');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showOverlay());

  app.whenReady().then(() => {
    createOverlay();
    registerHotkey();
    startClipboardPolling();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
