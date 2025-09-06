// main.js — Paste on Select added without touching your preload/renderer/features

const {
  app, BrowserWindow, globalShortcut, clipboard, ipcMain, nativeImage, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');

const StoreMod = require('electron-store');
const Store = StoreMod.default || StoreMod;

const { createWorker } = require('tesseract.js');

let ocrWorker;

/* ---------- tiny logger (terminal only) ---------- */
function dlog(tag, payload = {}) {
  try {
    const enabled = settingsStore ? settingsStore.get('debugLogging') : true;
    if (!enabled) return;
  } catch (e) {}
  const ts = new Date().toISOString().replace('T',' ').replace('Z','');
  try { console.log(`[${ts}] ${tag}`, JSON.stringify(payload)); }
  catch { console.log(`[${ts}] ${tag}`, payload); }
}

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

/* ---------- Stores ---------- */
const settingsStore = new Store({
  name: 'settings',
  defaults: {
    theme: 'dark',
    hotkey: 'CommandOrControl+Shift+Space',
    maxItems: 500,
    captureContext: false,       // your original option
    searchMode: 'fuzzy',
    fuzzyThreshold: 0.4,
    // NEW (no UI change; default ON)
    autoPasteOnSelect: true,
    debugLogging: true,
    overlaySize: 'large', // NEW
  },
});
const historyStore = new Store({ name: 'history', defaults: { items: [] } });

/* ---------- Active window capture (for context + paste target) ---------- */
let activeWinGetter = null;
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
let activeWinTimer = null;
let lastRealWin = null;

function captureSourceIfEnabled() {
  if (!settingsStore.get('captureContext')) return undefined;
  const MAX_AGE = 7000;
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

/* ---------- NEW: precise target for auto-paste ---------- */
let lastActive = { pid: null, title: '', hwnd: null };
async function captureActiveTarget() {
  try {
    const getWin = await maybeLoadActiveWin();
    if (!getWin) { lastActive = { pid: null, title: '', hwnd: null }; return; }
    const info = await getWin();
    if (info && !isNoiseWindow(info)) {
      lastActive = {
        pid: Number.isFinite(info?.owner?.processId) ? info.owner.processId : null,
        title: String(info?.title || ''),
        hwnd: Number.isFinite(info?.id) ? info.id
           : Number.isFinite(info?.windowId) ? info.windowId
           : null,
      };
      dlog('target:capture', lastActive);
    } else {
      lastActive = { pid: null, title: '', hwnd: null };
      dlog('target:capture:none');
    }
  } catch (e) {
    lastActive = { pid: null, title: '', hwnd: null };
    dlog('target:capture:error', { msg: e?.message });
  }
}

/* ---------- Helpers ---------- */
function userDir(...p) { return path.join(app.getPath('userData'), ...p); }
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean).map(s => String(s).toLowerCase())));

function overlayWH(size) {
  switch ((size || 'large').toLowerCase()) {
    case 'small':  return { width: 640, height: 440 };
    case 'medium': return { width: 800, height: 520 };
    default:       return { width: 900, height: 560 }; // current size = large
  }
}

// Centers the overlay on the display under the mouse cursor
function centerOverlayOnActiveDisplay(win, width, height) {
  try {
    const { screen } = require('electron');
    const pt = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(pt);
    const wa = disp.workArea || disp.bounds; // prefer workArea if available
    const x = Math.floor(wa.x + (wa.width  - width)  / 2);
    const y = Math.floor(wa.y + (wa.height - height) / 2);
    win.setBounds({ x, y, width, height }, false);
  } catch (e) {
    // Fallback: built-in center (may use primary display)
    try { win.center(); } catch {}
  }
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

/* ---------- Sorting / cleanup ---------- */
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
let overlayWin = null;
function createOverlay() {
  if (overlayWin) return overlayWin;

  const { width, height } = overlayWH(settingsStore.get('overlaySize')); // small/medium/large
  overlayWin = new BrowserWindow({
    width,
    height,
    useContentSize: true,               // <-- important for reliable downsizing
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

  // Center on first create, using the actual window outer size
  try {
    const [w, h] = overlayWin.getSize();
    centerOverlayOnActiveDisplay(overlayWin, w, h);
  } catch {}

  return overlayWin;
}

function showOverlay() {
  const win = createOverlay();
  if (!win) return;

  // remember paste target before showing (keeps caret in the other app)
  try { captureActiveTarget?.(); } catch {}

  // Apply current CONTENT size every time, then re-center using OUTER size
  try {
    const { width: cw, height: ch } = overlayWH(settingsStore.get('overlaySize'));
    win.setContentSize(cw, ch);                 // <-- downsizing-safe
    const [w, h] = win.getSize();               // outer size after content resize
    centerOverlayOnActiveDisplay(win, w, h);
    console.log('[overlay:size]', {
      overlaySize: settingsStore.get('overlaySize'),
      content: { width: cw, height: ch },
      window:  { width: w,  height: h  }
    });
  } catch (e) {
    console.log('[overlay:size:error]', e?.message);
  }

  // Show without stealing focus
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
  if (!win.isVisible()) win.showInactive();

  win.webContents.send('overlay:show');
  win.webContents.send('overlay:anim', true);
  console.log('[overlay] show (inactive)');
}






/* ---------- Hotkey ---------- */
function registerHotkey() {
  const hk = (settingsStore.get('hotkey') || 'CommandOrControl+Shift+Space').trim();
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hk, showOverlay);
  if (!ok) globalShortcut.register('CommandOrControl+Shift+Space', showOverlay);
}

/* ---------- Clipboard polling (text + images + OCR) ---------- */
let clipboardPollTimer = null;
let lastClipboardText = '';
let lastImageHash = '';

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const found = resolveEngData();
  if (!found) throw new Error('ENG model not found');
  dlog('ocr:init', found);
  ocrWorker = await createWorker('eng', undefined, {
    langPath: found.dir,
    gzip: found.gzip,
    cachePath: path.join(app.getPath('userData'), 'tess-cache'),
    workerBlobURL: false,
  });
  return ocrWorker;
}
const RX = {
  url: /\b((https?:\/\/|www\.)[^\s/$.?#].[^\s]*)/i,
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  mdDate: /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/i,
  monthDate: /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t)?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)[^\n]*\b(\d{1,2})(st|nd|rd|th)?\b/i,
  number: /\b\d[\d,]*([.]\d+)?\b/,
};
function looksLikeCode(s) {
  if (!s) return false;
  const lines = String(s).split('\n');
  if (lines.length >= 3 && /[{;}()=<>[\]]/.test(s)) return true;
  if (/```/.test(s)) return true;
  if (/\b(function|const|let|var|class|import|export|def|public|private|if|else|for|while|return|try|catch)\b/.test(s)) return true;
  return false;
}
function autoTagsForText(text) {
  const t = String(text || '');
  const tags = [];
  if (RX.url.test(t)) tags.push('url');
  if (RX.email.test(t)) tags.push('email');
  if (RX.mdDate.test(t) || RX.monthDate.test(t)) tags.push('date');
  if (RX.number.test(t)) tags.push('number');
  if (looksLikeCode(t)) tags.push('code');
  return Array.from(new Set(tags));
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
          const source = captureSourceIfEnabled();

          const id = Date.now();
          const meta = await persistImage(img, id);
          const items = historyStore.get('items') || [];
          items.unshift({ id, type: 'image', pinned: false, ts: new Date().toISOString(), source, tags: [], ...meta });
          sortItems(items);
          await enforceMaxAndCleanup(items);
          historyStore.set('items', items);
          overlayWin?.webContents?.send('history:update', items);
          dlog('capture:image', { id, filePath: meta.filePath, wh: meta.wh });

          // OCR async
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
                const addTags = autoTagsForText(text);
                const existing = Array.from(new Set(itemsNow[idx].tags || []));
                itemsNow[idx].ocrText = text.length > 12000 ? text.slice(0, 12000) : text;
                itemsNow[idx].tags = Array.from(new Set([...existing, ...addTags, 'ocr']));
                historyStore.set('items', itemsNow);
                overlayWin?.webContents?.send('history:update', itemsNow);
                dlog('ocr:done', { id, tags: addTags });
              }
            } catch (e) {
              dlog('ocr:error', { msg: e?.message });
            }
          })();
          return;
        }
      }
    } catch (e) {
      dlog('capture:image:error', { msg: e?.message });
    }

    // Text
    const text = clipboard.readText();
    if (!text || !text.trim()) return;
    if (text === lastClipboardText) return;
    lastClipboardText = text;

    const source = captureSourceIfEnabled();

    const items = historyStore.get('items') || [];
    if (items.length && items[0].type === 'text' && items[0].text === text) return;

    const id = Date.now();
    const tags = autoTagsForText(text);
    items.unshift({ id, type: 'text', text, pinned: false, ts: new Date().toISOString(), source, tags });
    sortItems(items);
    await enforceMaxAndCleanup(items);
    historyStore.set('items', items);
    overlayWin?.webContents?.send('history:update', items);
    dlog('capture:text', { id, tags, len: text.length });
  }, 200);
}

/* ---------- IPC ---------- */
ipcMain.handle('overlay:resize', (_e, size) => {
  if (!overlayWin) return false;
  const { width, height } = overlayWH(size || settingsStore.get('overlaySize'));
  try { overlayWin.setSize(width, height, false); return true; }
  catch (e) { console.log('overlay:resize:error', e.message); return false; }
});

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
  autoPasteOnSelect: settingsStore.get('autoPasteOnSelect'),
  debugLogging: settingsStore.get('debugLogging'),
  overlaySize: settingsStore.get('overlaySize'),
}));
ipcMain.handle('settings:save', async (_e, s) => {
  settingsStore.set('theme', s.theme === 'light' ? 'light' : 'dark');
  settingsStore.set('hotkey', s.hotkey || 'CommandOrControl+Shift+Space');
  settingsStore.set('maxItems', Math.max(50, Math.min(5000, parseInt(s.maxItems || 500, 10))));
  settingsStore.set('captureContext', !!s.captureContext);
  settingsStore.set('searchMode', s.searchMode === 'exact' ? 'exact' : 'fuzzy');
  const th = Number.isFinite(+s.fuzzyThreshold) ? Math.min(0.9, Math.max(0.1, +s.fuzzyThreshold)) : 0.4;
  settingsStore.set('fuzzyThreshold', th);
  if (Object.prototype.hasOwnProperty.call(s, 'autoPasteOnSelect')) settingsStore.set('autoPasteOnSelect', !!s.autoPasteOnSelect);
  if (Object.prototype.hasOwnProperty.call(s, 'debugLogging')) settingsStore.set('debugLogging', !!s.debugLogging);
  if (Object.prototype.hasOwnProperty.call(s, 'overlaySize')) {
      const v = String(s.overlaySize || '').toLowerCase();
      settingsStore.set('overlaySize', ['small','medium','large'].includes(v) ? v : 'large');
    }
  registerHotkey();

  if (settingsStore.get('captureContext')) {
    await startActiveWinSampling();
  } else {
    stopActiveWinSampling();
  }
  return true;
});

/* ---------- Auto-paste driver (Windows) ---------- */
function pasteKeystroke() {
  try { overlayWin?.setAlwaysOnTop(false); } catch {}
  try { overlayWin?.hide(); } catch {}

  console.log('autopaste:start', { platform: process.platform, lastActive });

  setTimeout(() => {
    try {
      if (process.platform === 'win32') {
        const hwnd  = Number(lastActive?.hwnd || 0);
        const title = String(lastActive?.title || '').replace(/"/g, '""');

        const ps = `
$hwnd = ${hwnd}
$title = "${title}"
if ($hwnd -gt 0) {
  $code = @'
using System;
using System.Runtime.InteropServices;
public static class P {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_V = 0x56;
  public static void Paste() {
    var ctrlDown = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL } } };
    var vDown    = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_V } } };
    var vUp      = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_V, dwFlags = KEYEVENTF_KEYUP } } };
    var ctrlUp   = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL, dwFlags = KEYEVENTF_KEYUP } } };
    INPUT[] inputs = new INPUT[] { ctrlDown, vDown, vUp, ctrlUp };
    SendInput((uint)inputs.Length, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
  Add-Type -TypeDefinition $code -Language CSharp
  [P]::ShowWindowAsync([IntPtr]$hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 10
  [P]::SetForegroundWindow([IntPtr]$hwnd) | Out-Null
  Start-Sleep -Milliseconds 10
  [P]::Paste()
  "OK"
} else { "NOHWND" }`.trim();

        const { spawn } = require('child_process');
        const pr = spawn('powershell.exe',
          ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', ps],
          { windowsHide: true });
        let out = '', err = '';
        pr.stdout.on('data', d => out += d.toString());
        pr.stderr.on('data', d => err += d.toString());
        pr.on('exit', code => console.log('autopaste:done', { code, out: out.trim(), err: err.trim() }));
      } else {
        console.log('autopaste:skip', { platform: process.platform });
      }
    } catch (e) {
      console.log('autopaste:error', { msg: e?.message });
    }
  }, 16); // fast, stable
}



/* ---------- clipboard:set (trigger auto-paste if enabled) ---------- */
ipcMain.handle('clipboard:set', async (_e, data) => {
  try {
    // write to clipboard
    if (data?.text) {
      clipboard.writeText(String(data.text));
    } else if (data?.imagePath) {
      try { const img = nativeImage.createFromPath(data.imagePath); if (!img.isEmpty()) clipboard.writeImage(img); } catch {}
    } else if (data?.imageDataUrl) {
      try { const img = nativeImage.createFromDataURL(data.imageDataUrl); if (!img.isEmpty()) clipboard.writeImage(img); } catch {}
    }

    const autoPaste = !!settingsStore.get('autoPasteOnSelect');
    console.log('clipboard:set', { type: data?.text ? 'text' : (data?.imagePath || data?.imageDataUrl ? 'image' : 'unknown'), autoPaste });

    if (autoPaste) {
      pasteKeystroke();        // will log autopaste:start / done
    } else {
      overlayWin?.hide();      // just copy & close
    }
    return true;
  } catch (e) {
    console.log('clipboard:set:error', e?.message);
    return false;
  }
});



/* ---------- Lifecycle ---------- */
app.setAppUserModelId('com.fouwaz.snippetstash');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => showOverlay());
  app.whenReady().then(async () => {
    dlog('app:ready', { userData: app.getPath('userData') });
    createOverlay();
    registerHotkey();
    startClipboardPolling();
    if (settingsStore.get('captureContext')) await startActiveWinSampling();
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopActiveWinSampling(); });
}
