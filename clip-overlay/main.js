// main.js — adds safe "Capture app/window context"
const {
  app, BrowserWindow, globalShortcut, clipboard, ipcMain, nativeImage, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const StoreMod = require('electron-store');
const Store = StoreMod.default || StoreMod;

const { createWorker } = require('tesseract.js');

let ocrWorker;

/* ---------- Tesseract language resolution (local/resources/node_modules) ---------- */
function findEngModelDir(baseDir) {
  if (!baseDir) return null;
  try {
    const stack = [baseDir];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/^eng\.traineddata(\.gz)?$/i.test(e.name)) {
          return { dir: path.dirname(p), gzip: e.name.toLowerCase().endsWith('.gz') };
        }
      }
    }
  } catch {}
  return null;
}
function resolveFromNodeModules() {
  try {
    const base = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    return findEngModelDir(base);
  } catch { return null; }
}
function resolveEngData() {
  const local = findEngModelDir(path.join(process.cwd(), 'tessdata', 'eng'));
  if (local) return { ...local, origin: 'local' };

  const res = findEngModelDir(path.join(process.resourcesPath || '', 'tessdata', 'eng'));
  if (res) return { ...res, origin: 'resources' };

  const mod = resolveFromNodeModules();
  if (mod) return { ...mod, origin: 'node_modules' };

  return null;
}
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const found = resolveEngData();
  if (!found) throw new Error('ENG model not found. Provide tessdata/eng/.../eng.traineddata(.gz) or install @tesseract.js-data/eng');
  console.log(`[ocr] langDir = ${found.dir}  origin: ${found.origin}  gzip: ${found.gzip}`);
  ocrWorker = await createWorker('eng', undefined, {
    langPath: found.dir,
    gzip: found.gzip,
    cachePath: path.join(app.getPath('userData'), 'tess-cache'),
    workerBlobURL: false,
  });
  return ocrWorker;
}
app.on('will-quit', async () => { try { await ocrWorker?.terminate(); } catch {} });

/* ---------- Stores ---------- */
const settingsStore = new Store({
  name: 'settings',
  defaults: {
    theme: 'dark',
    hotkey: 'CommandOrControl+Shift+Space',
    maxItems: 500,
    captureContext: false,       // UI toggle; now honored
    searchMode: 'fuzzy',
    fuzzyThreshold: 0.4,
  },
});
const historyStore = new Store({ name: 'history', defaults: { items: [] } });

/* ---------- State ---------- */
let overlayWin = null;
let clipboardPollTimer = null;
let lastClipboardText = '';
let lastImageHash = '';

/* ---------- Context capture (active-win; ESM safe) ---------- */
let activeWinGetter = null;   // function or null
let activeWinTimer = null;
let lastRealWin = null;       // { app, title, ts }

async function maybeLoadActiveWin() {
  if (activeWinGetter !== null) return activeWinGetter; // cached
  try {
    const mod = await import('active-win');
    activeWinGetter = typeof mod.default === 'function' ? mod.default : null;
  } catch {
    activeWinGetter = null;
  }
  return activeWinGetter;
}
function isNoiseWindow(info) {
  const title = (info?.title || '').toLowerCase();
  const appName = (info?.owner?.name || '').toLowerCase();

  if (appName.includes('snippetstash') || appName.includes('electron')) return true;

  const badTitles = ['snipping tool', 'screen snipping', 'screenclip', 'screenshot', 'capture'];
  const badApps   = ['snipping tool', 'screen snipping', 'screenclip', 'shell experiences', 'windows input'];
  if (badTitles.some(x => title.includes(x))) return true;
  if (badApps.some(x => appName.includes(x))) return true;

  if (!title.trim()) return true;

  return false;
}
async function startActiveWinSampling() {
  const getWin = await maybeLoadActiveWin();
  if (!getWin) return; // gracefully no-op if not available
  if (activeWinTimer) clearInterval(activeWinTimer);

  activeWinTimer = setInterval(async () => {
    try {
      const info = await getWin();
      if (info && !isNoiseWindow(info)) {
        lastRealWin = {
          app: info.owner?.name || '',
          title: info.title || '',
          ts: Date.now(),
        };
      }
    } catch {}
  }, 800);
}
function stopActiveWinSampling() {
  if (activeWinTimer) clearInterval(activeWinTimer);
  activeWinTimer = null;
  lastRealWin = null;
}
function pickContextNowSync() {
  const MAX_AGE = 7000; // ms
  if (lastRealWin && (Date.now() - lastRealWin.ts) <= MAX_AGE) {
    return { app: lastRealWin.app, title: lastRealWin.title };
  }
  return undefined;
}
async function pickContextOnDemand() {
  const getWin = await maybeLoadActiveWin();
  if (!getWin) return undefined;
  try {
    const info = await getWin();
    if (info && !isNoiseWindow(info)) {
      return { app: info.owner?.name || '', title: info.title || '' };
    }
  } catch {}
  return undefined;
}

/* ---------- Helpers ---------- */
function userDir(...p) { return path.join(app.getPath('userData'), ...p); }
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

async function persistImage(nimg, id) {
  const outDir = userDir('clips', 'imgs'); await ensureDir(outDir);
  const png = nimg.toPNG();
  const filePath = path.join(outDir, `${id}.png`);
  await fsp.writeFile(filePath, png);

  const sz = nimg.getSize();
  const w = Math.min(320, Math.max(64, sz.width));
  const thumbImg = nimg.resize({ width: w, quality: 'best' });
  const thumb = 'data:image/png;base64,' + thumbImg.toPNG().toString('base64');
  return { filePath, thumb, wh: { w: sz.width, h: sz.height } };
}

function readClipboardImageRobust() {
  let img = clipboard.readImage();
  if (img && !img.isEmpty()) return img;
  try {
    const fmts = clipboard.availableFormats();
    const imageLike = fmts.filter(f => /image|png|jpg|jpeg|bmp|dib|bitmap|jfif/i.test(f));
    for (const f of imageLike) {
      const data = clipboard.readBuffer(f);
      if (data?.length) {
        const nimg = nativeImage.createFromBuffer(data);
        if (nimg && !nimg.isEmpty()) return nimg;
      }
    }
  } catch {}
  return nativeImage.createEmpty();
}

function sortItems(items) {
  items.sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    new Date(b.ts) - new Date(a.ts)
  );
}
async function enforceMaxAndCleanup(items) {
  const max = settingsStore.get('maxItems') || 500;
  if (items.length <= max) return;
  const removed = items.splice(max);
  await Promise.all(removed.map(it =>
    (it.type === 'image' && it.filePath) ? fsp.unlink(it.filePath).catch(()=>{}) : Promise.resolve()
  ));
}

/* ---------- Overlay ---------- */
function createOverlay() {
  if (overlayWin) return overlayWin;
  overlayWin = new BrowserWindow({
    width: 900, height: 560, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, sandbox: false,
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

/* ---------- Hotkey ---------- */
function registerHotkey() {
  const hk = (settingsStore.get('hotkey') || 'CommandOrControl+Shift+Space').trim();
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hk, showOverlay);
  if (!ok) globalShortcut.register('CommandOrControl+Shift+Space', showOverlay);
}

/* ---------- Clipboard polling (adds context when enabled) ---------- */
function captureSourceIfEnabled() {
  if (!settingsStore.get('captureContext')) return undefined;
  return pickContextNowSync();
}
function startClipboardPolling() {
  if (clipboardPollTimer) clearInterval(clipboardPollTimer);
  clipboardPollTimer = setInterval(async () => {
    try {
      const img = readClipboardImageRobust();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        const hash = sha1(png);
        if (hash !== lastImageHash) {
          lastImageHash = hash;

          let source = captureSourceIfEnabled();
          if (!source && settingsStore.get('captureContext')) {
            source = await pickContextOnDemand();
          }

          const id = Date.now();
          const meta = await persistImage(img, id);
          const items = historyStore.get('items') || [];
          items.unshift({ id, type: 'image', pinned: false, ts: new Date().toISOString(), source, ...meta });
          sortItems(items);
          await enforceMaxAndCleanup(items);
          historyStore.set('items', items);
          overlayWin?.webContents?.send('history:update', items);

          // OCR off-thread
          (async () => {
            try {
              const worker = await getOcrWorker();
              const buf = await fsp.readFile(meta.filePath);
              const { data } = await worker.recognize(buf);
              const text = (data?.text || '').trim();
              if (!text) return;
              const itemsNow = historyStore.get('items') || [];
              const idx = itemsNow.findIndex(i => i.id === id);
              if (idx >= 0) {
                itemsNow[idx].ocrText = text.length > 12000 ? text.slice(0, 12000) : text;
                historyStore.set('items', itemsNow);
                overlayWin?.webContents?.send('history:update', itemsNow);
              }
            } catch (e) { console.warn('[ocr]', e?.message); }
          })();

          return;
        }
      }
    } catch (e) { console.warn('[clip] image read error:', e?.message); }

    const text = clipboard.readText();
    if (!text || !text.trim()) return;
    if (text === lastClipboardText) return;
    lastClipboardText = text;

    let source = captureSourceIfEnabled();
    if (!source && settingsStore.get('captureContext')) {
      source = await pickContextOnDemand();
    }

    const items = historyStore.get('items') || [];
    if (items.length && items[0].type === 'text' && items[0].text === text) return;

    const id = Date.now();
    items.unshift({ id, type: 'text', text, pinned: false, ts: new Date().toISOString(), source });
    sortItems(items);
    await enforceMaxAndCleanup(items);
    historyStore.set('items', items);
    overlayWin?.webContents?.send('history:update', items);
  }, 200);
}

/* ---------- IPC ---------- */
ipcMain.handle('history:get', () => historyStore.get('items') || []);
ipcMain.handle('history:clear', async () => {
  const items = historyStore.get('items') || [];
  for (const it of items) if (it.type === 'image' && it.filePath) { try { await fsp.unlink(it.filePath); } catch {} }
  historyStore.set('items', []);
  overlayWin?.webContents?.send('history:update', []);
  return true;
});
ipcMain.handle('history:updateItem', (_e, { id, patch }) => {
  const items = historyStore.get('items') || [];
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...patch };
    sortItems(items);
    historyStore.set('items', items);
    overlayWin?.webContents?.send('history:update', items);
  }
  return true;
});
ipcMain.handle('delete-history-item', async (_e, id) => {
  const items = historyStore.get('items') || [];
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0) {
    const it = items[idx];
    if (it.type === 'image' && it.filePath) { try { await fsp.unlink(it.filePath); } catch {} }
  }
  const filtered = items.filter(i => i.id !== id);
  historyStore.set('items', filtered);
  overlayWin?.webContents?.send('history:update', filtered);
  return true;
});
ipcMain.handle('open-url', async (_event, url) => {
  try { await shell.openExternal(url); return true; } catch { return false; }
});

ipcMain.handle('settings:get', () => ({
  theme: settingsStore.get('theme'),
  hotkey: settingsStore.get('hotkey'),
  maxItems: settingsStore.get('maxItems'),
  captureContext: settingsStore.get('captureContext'),
  searchMode: settingsStore.get('searchMode'),
  fuzzyThreshold: settingsStore.get('fuzzyThreshold'),
}));
ipcMain.handle('settings:save', async (_e, s) => {
  settingsStore.set('theme', s.theme === 'light' ? 'light' : 'dark');
  settingsStore.set('hotkey', s.hotkey || 'CommandOrControl+Shift+Space');
  settingsStore.set('maxItems', Math.max(50, Math.min(5000, parseInt(s.maxItems || 500, 10))));
  settingsStore.set('captureContext', !!s.captureContext);
  settingsStore.set('searchMode', s.searchMode === 'exact' ? 'exact' : 'fuzzy');
  const th = Number.isFinite(+s.fuzzyThreshold) ? Math.min(0.9, Math.max(0.1, +s.fuzzyThreshold)) : 0.4;
  settingsStore.set('fuzzyThreshold', th);

  registerHotkey();

  if (settingsStore.get('captureContext')) {
    await startActiveWinSampling();
  } else {
    stopActiveWinSampling();
  }
  return true;
});

ipcMain.handle('clipboard:set', (_e, data) => {
  if (data?.text) { clipboard.writeText(String(data.text)); return true; }
  if (data?.imagePath) {
    try { const img = nativeImage.createFromPath(data.imagePath); if (!img.isEmpty()) clipboard.writeImage(img); } catch {}
    return true;
  }
  if (data?.imageDataUrl) {
    try { const img = nativeImage.createFromDataURL(data.imageDataUrl); if (!img.isEmpty()) clipboard.writeImage(img); } catch {}
    return true;
  }
  return false;
});

/* ---------- Lifecycle ---------- */
app.setAppUserModelId('com.fouwaz.snippetstash');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => showOverlay());
  app.whenReady().then(async () => {
    createOverlay();
    registerHotkey();
    startClipboardPolling();
    if (settingsStore.get('captureContext')) await startActiveWinSampling();
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopActiveWinSampling(); });
}
