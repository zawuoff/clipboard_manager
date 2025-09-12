// main.js — Paste on Select added without touching your preload/renderer/features

const {
  app, BrowserWindow, globalShortcut, clipboard, ipcMain, nativeImage, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

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
    // overlaySize removed - now using single fixed size
    // Text shortcuts settings
    enableTextShortcuts: true,
    shortcutTriggerPrefix: '//',
    shortcutCaseSensitive: false,
    shortcutMinLength: 2,
    showShortcutNotifications: true,
    smartPasteHotkey: 'F12',
    enableSmartPaste: true,
  },
});
const historyStore = new Store({ name: 'history', defaults: { items: [] } });
const shortcutsStore = new Store({ name: 'shortcuts', defaults: { mapping: {} } });

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

function overlayWH() {
  // Single fixed size: 15% bigger than medium (800x520) = 920x600
  return { width: 920, height: 600 };
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
  if (items.length <= max) {
    // Still cleanup orphaned shortcuts even if under limit
    const validIds = items.map(i => i.id);
    cleanupShortcuts(validIds);
    return;
  }
  
  const removed = items.splice(max);
  
  // Remove shortcuts for deleted items
  for (const it of removed) {
    if (it.shortcut) {
      updateShortcutMapping(it.id, it.shortcut, null);
    }
  }
  
  await Promise.all(removed.map(it =>
    (it.type === 'image' && it.filePath) ? fsp.unlink(it.filePath).catch(()=>{}) : Promise.resolve()
  ));
}

/* ---------- Overlay ---------- */
let overlayWin = null;
function createOverlay() {
  if (overlayWin) return overlayWin;

  const { width, height } = overlayWH(); // single fixed size
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
    const { width: cw, height: ch } = overlayWH();
    win.setContentSize(cw, ch);                 // <-- downsizing-safe
    const [w, h] = win.getSize();               // outer size after content resize
    centerOverlayOnActiveDisplay(win, w, h);
    console.log('[overlay:size]', {
      // overlaySize removed
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

/* ---------- AutoHotkey Smart Paste Integration v2 ---------- */
let ahkProcess = null;
let shortcutsFilePath = null;
let ahkConfigPath = null;

/* ---------- Global text monitoring for shortcuts ---------- */
let textBuffer = '';
let lastKeystroke = 0;
const BUFFER_TIMEOUT = 2000; // Clear buffer after 2 seconds of inactivity
const MAX_BUFFER_LENGTH = 50;

function clearTextBuffer() {
  textBuffer = '';
  lastKeystroke = 0;
}

function addToTextBuffer(char) {
  const now = Date.now();
  
  // Clear buffer if too much time has passed
  if (now - lastKeystroke > BUFFER_TIMEOUT) {
    textBuffer = '';
  }
  
  // Add character to buffer
  textBuffer += char;
  lastKeystroke = now;
  
  // Limit buffer size
  if (textBuffer.length > MAX_BUFFER_LENGTH) {
    textBuffer = textBuffer.slice(-MAX_BUFFER_LENGTH);
  }
}

function detectShortcutInBuffer() {
  if (!textBuffer) return null;
  
  // Look for word at end of buffer (letters, numbers, underscores, hyphens)
  const match = textBuffer.match(/([a-zA-Z0-9_-]+)$/);
  if (!match) return null;
  
  const keyword = match[1];
  const minLength = settingsStore.get('shortcutMinLength') || 2;
  
  if (keyword.length < minLength) return null;
  
  const caseSensitive = settingsStore.get('shortcutCaseSensitive') || false;
  const mapping = getShortcutsMapping();
  
  // Check for exact match or case-insensitive match
  const shortcutKey = caseSensitive ? keyword : keyword.toLowerCase();
  const foundKey = caseSensitive 
    ? Object.keys(mapping).find(k => k === shortcutKey)
    : Object.keys(mapping).find(k => k.toLowerCase() === shortcutKey);
  
  if (foundKey && mapping[foundKey]) {
    return {
      keyword: foundKey,
      itemId: mapping[foundKey],
      matchLength: keyword.length
    };
  }
  
  return null;
}

async function expandShortcut(shortcut) {
  const items = historyStore.get('items') || [];
  const item = items.find(i => i.id === shortcut.itemId);
  
  if (!item) {
    dlog('shortcut:expand:notfound', { itemId: shortcut.itemId, keyword: shortcut.keyword });
    return false;
  }
  
  try {
    // Delete the typed shortcut keyword (simulate backspaces)
    for (let i = 0; i < shortcut.matchLength; i++) {
      await simulateBackspace();
      await new Promise(r => setTimeout(r, 5)); // Small delay between backspaces
    }
    
    // Small delay before pasting
    await new Promise(r => setTimeout(r, 50));
    
    // Set clipboard and paste
    if (item.type === 'image') {
      clipboard.writeImage(nativeImage.createFromPath(item.filePath));
    } else {
      clipboard.writeText(item.text);
    }
    
    // Execute paste
    pasteKeystroke();
    
    dlog('shortcut:expand:success', { keyword: shortcut.keyword, itemId: item.id, type: item.type });
    
    // Show notification if enabled
    if (settingsStore.get('showShortcutNotifications')) {
      // Could add system notification here if desired
    }
    
    return true;
  } catch (error) {
    dlog('shortcut:expand:error', { error: error.message, keyword: shortcut.keyword });
    return false;
  }
}

async function simulateBackspace() {
  if (process.platform !== 'win32') return;
  
  try {
    const ps = `
$code = @'
using System;
using System.Runtime.InteropServices;
public static class Keys {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const ushort VK_BACK = 0x08;
  public static void Backspace() {
    var down = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_BACK } } };
    var up   = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_BACK, dwFlags = KEYEVENTF_KEYUP } } };
    INPUT[] inputs = new INPUT[] { down, up };
    SendInput((uint)inputs.Length, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[Keys]::Backspace()
"OK"`.trim();

    const pr = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true });
    
    return new Promise((resolve) => {
      pr.on('exit', () => resolve());
    });
  } catch (error) {
    dlog('backspace:error', { error: error.message });
  }
}

// Clipboard-based text monitoring for shortcuts
let shortcutMonitorInterval = null;
let lastProcessedClipboard = '';

function startTextMonitoring() {
  if (!settingsStore.get('enableTextShortcuts')) return;
  
  try {
    // Monitor clipboard changes rapidly to detect when shortcuts are copied and immediately replace them
    shortcutMonitorInterval = setInterval(async () => {
      try {
        await checkForShortcutExpansion();
      } catch (error) {
        dlog('shortcut:monitor:error', { error: error.message });
      }
    }, 50); // Check every 50ms for rapid response
    
    dlog('shortcut:monitor:started', { 
      prefix: settingsStore.get('shortcutTriggerPrefix') || '//',
      note: `Type //shortcut, select it, copy (Ctrl+C), then paste (Ctrl+V) to expand` 
    });
    
  } catch (error) {
    dlog('shortcut:monitor:start:error', { error: error.message });
  }
}

async function checkForShortcutExpansion() {
  if (!settingsStore.get('enableTextShortcuts')) return;
  
  const clipboardText = clipboard.readText();
  if (!clipboardText || clipboardText === lastProcessedClipboard) return;
  
  const prefix = settingsStore.get('shortcutTriggerPrefix') || '//';
  const shortcutPattern = new RegExp(`^${escapeRegExp(prefix)}([a-zA-Z0-9_-]+)$`);
  const match = clipboardText.trim().match(shortcutPattern);
  
  if (match) {
    const keyword = match[1];
    lastProcessedClipboard = clipboardText;
    
    dlog('shortcut:detected', { keyword, clipboardText });
    
    // Immediately replace clipboard content
    const success = await expandShortcutToClipboard(keyword);
    if (success) {
      dlog('shortcut:ready-for-paste', { keyword, clipboard: 'replaced' });
    }
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function expandShortcutToClipboard(keyword) {
  try {
    const mapping = getShortcutsMapping();
    const caseSensitive = settingsStore.get('shortcutCaseSensitive') || false;
    
    const foundKey = caseSensitive 
      ? Object.keys(mapping).find(k => k === keyword)
      : Object.keys(mapping).find(k => k.toLowerCase() === keyword.toLowerCase());
    
    if (foundKey && mapping[foundKey]) {
      const items = historyStore.get('items') || [];
      const item = items.find(i => i.id === mapping[foundKey]);
      
      if (item) {
        // Replace clipboard content with the actual content
        if (item.type === 'image') {
          const img = nativeImage.createFromPath(item.filePath);
          clipboard.writeImage(img);
        } else {
          clipboard.writeText(item.text);
        }
        
        dlog('shortcut:expanded', { 
          keyword: foundKey, 
          itemId: item.id, 
          type: item.type
        });
        
        // Show notification if enabled
        if (settingsStore.get('showShortcutNotifications')) {
          // Could add system notification here
        }
        
        return true;
      }
    }
    
    dlog('shortcut:nomatch', { keyword, availableShortcuts: Object.keys(mapping) });
    return false;
    
  } catch (error) {
    dlog('shortcut:expand:error', { error: error.message, keyword });
    return false;
  }
}

function stopTextMonitoring() {
  if (shortcutMonitorInterval) {
    clearInterval(shortcutMonitorInterval);
    shortcutMonitorInterval = null;
    lastProcessedClipboard = '';
    dlog('shortcut:monitor:stopped');
  }
}

// Handle manual shortcut expansion trigger (for testing/fallback)
ipcMain.handle('shortcut:expand', async (_e, keyword) => {
  const mapping = getShortcutsMapping();
  const itemId = mapping[keyword];
  
  if (!itemId) return false;
  
  const shortcut = { keyword, itemId, matchLength: keyword.length };
  return await expandShortcut(shortcut);
});

/* ---------- IPC ---------- */
// Resize handler removed - using single fixed size

ipcMain.handle('history:get', () => historyStore.get('items') || []);
ipcMain.handle('history:clear', async () => {
  const items = historyStore.get('items') || [];
  for (const it of items) if (it.type === 'image' && it.filePath) { try { await fsp.unlink(it.filePath); } catch {} }
  historyStore.set('items', []);
  overlayWin?.webContents?.send('history:update', []);

  // clear itemIds from all collections
  const list = getCollections();
  for (const c of list) { c.itemIds = []; c.updatedAt = new Date().toISOString(); }
  setCollections(list);
  broadcastCollections();

  // clear all shortcuts
  setShortcutsMapping({});
  updateShortcutsFile().catch(() => {});

  return true;
});

ipcMain.handle('history:updateItem', (_e, { id, patch }) => {
  const items = historyStore.get('items') || [];
  const idx = items.findIndex(i => i.id === id);
  if (idx >= 0) {
    const oldItem = items[idx];
    const oldShortcut = oldItem.shortcut;
    const newShortcut = patch.shortcut;
    
    items[idx] = { ...items[idx], ...patch };
    
    // Update shortcuts mapping if shortcut changed
    if (oldShortcut !== newShortcut) {
      updateShortcutMapping(id, oldShortcut, newShortcut);
    }
    
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
    
    // Remove shortcut mapping if exists
    if (it.shortcut) {
      updateShortcutMapping(id, it.shortcut, null);
    }
  }
  const filtered = items.filter(i => i.id !== id);
  historyStore.set('items', filtered);
  overlayWin?.webContents?.send('history:update', filtered);

  // remove from collections, if present
  const list = getCollections();
  let changed = false;
  for (const c of list) {
    const before = (c.itemIds || []).length;
    c.itemIds = (c.itemIds || []).filter(x => x !== id);
    if (c.itemIds.length !== before) { c.updatedAt = new Date().toISOString(); changed = true; }
  }
  if (changed) { setCollections(list); broadcastCollections(); }

  return true;
});

ipcMain.handle('open-url', async (_event, url) => {
  try { await shell.openExternal(url); return true; } catch { return false; }
});

// --- Collections store & IPC ---
const collectionsStore = new Store({ name: 'collections', defaults: { list: [] } });

function getCollections() { return collectionsStore.get('list') || []; }
function setCollections(list) { collectionsStore.set('list', list); }

// --- Text shortcuts helpers ---
function getShortcutsMapping() { return shortcutsStore.get('mapping') || {}; }
function setShortcutsMapping(mapping) { shortcutsStore.set('mapping', mapping); }

/* ---------- AutoHotkey Management ---------- */
async function initShortcutsFile() {
  shortcutsFilePath = path.join(__dirname, 'shortcuts.json');
  await updateShortcutsFile();
  registerExpansionHotkey();
}

// Register the expansion hotkey using Electron's global shortcut system
let expansionHotkey = 'F12';

function registerExpansionHotkey() {
  if (!settingsStore.get('enableSmartPaste')) return;
  
  const hotkey = settingsStore.get('smartPasteHotkey') || 'F12';
  
  try {
    // Unregister previous hotkey
    globalShortcut.unregister(expansionHotkey);
    
    // Register new hotkey
    expansionHotkey = hotkey;
    const success = globalShortcut.register(hotkey, handleExpansionHotkey);
    
    if (success) {
      dlog('expansion:hotkey:registered', { hotkey });
    } else {
      // Fallback to F12
      expansionHotkey = 'F12';
      globalShortcut.register('F12', handleExpansionHotkey);
      dlog('expansion:hotkey:fallback', { original: hotkey, fallback: 'F12' });
    }
  } catch (error) {
    dlog('expansion:hotkey:error', { error: error.message });
  }
}

// Handle the one-key expansion hotkey - Simple approach: just do Ctrl+C then Ctrl+V
async function handleExpansionHotkey() {
  if (!settingsStore.get('enableSmartPaste')) return;
  
  dlog('smart-paste:triggered');
  
  try {
    // Simple and reliable: let the existing clipboard monitor handle shortcut detection
    // Just send Ctrl+C followed by Ctrl+V
    
    dlog('smart-paste:sending-copy');
    await sendKeystroke('ctrl+c');
    
    // Brief pause to let the clipboard monitoring system process the shortcut
    await new Promise(resolve => setTimeout(resolve, 100));
    
    dlog('smart-paste:sending-paste');
    await sendKeystroke('ctrl+v');
    
    dlog('smart-paste:completed');
    
  } catch (error) {
    dlog('smart-paste:error', { error: error.message });
  }
}

// Send keystroke using Windows PowerShell - with multiple approaches
async function sendKeystroke(keys) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve();
      return;
    }

    let psCommand = '';
    
    if (keys === 'ctrl+c') {
      // Try a different approach: use WScript.Shell SendKeys which is often more reliable
      psCommand = `
try {
  # Method 1: Try SendKeys (often more reliable)
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait("^c")
  Write-Output "SendKeys-SUCCESS"
} catch {
  Write-Output "SendKeys-FAILED: $($_.Exception.Message)"
  
  # Method 2: Fallback to SendInput
  try {
    $code = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class K {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_C = 0x43;
  public static string Copy() {
    try {
      IntPtr activeWindow = GetForegroundWindow();
      if (activeWindow == IntPtr.Zero || !IsWindow(activeWindow)) {
        return "ERROR: No valid active window";
      }
      
      SetForegroundWindow(activeWindow);
      Thread.Sleep(50);
      
      var ctrlDown = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL } } };
      var cDown = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_C } } };
      var cUp = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_C, dwFlags = KEYEVENTF_KEYUP } } };
      var ctrlUp = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL, dwFlags = KEYEVENTF_KEYUP } } };
      
      uint result1 = SendInput(1, new INPUT[] { ctrlDown }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(10);
      uint result2 = SendInput(1, new INPUT[] { cDown }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(10);
      uint result3 = SendInput(1, new INPUT[] { cUp }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(10);
      uint result4 = SendInput(1, new INPUT[] { ctrlUp }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      
      return $"SendInput-SUCCESS: {result1},{result2},{result3},{result4}";
    } catch (Exception ex) {
      return $"SendInput-ERROR: {ex.Message}";
    }
  }
}
'@
    Add-Type -TypeDefinition $code -Language CSharp
    $result = [K]::Copy()
    Write-Output $result
  } catch {
    Write-Output "SendInput-FAILED: $($_.Exception.Message)"
  }
}`.trim();
    } else if (keys === 'ctrl+v') {
      psCommand = `
try {
  # Method 1: Try SendKeys (often more reliable)
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Write-Output "SendKeys-SUCCESS"
} catch {
  Write-Output "SendKeys-FAILED: $($_.Exception.Message)"
  
  # Method 2: Fallback to SendInput
  try {
    $code = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class K {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_V = 0x56;
  public static string Paste() {
    try {
      IntPtr activeWindow = GetForegroundWindow();
      if (activeWindow == IntPtr.Zero || !IsWindow(activeWindow)) {
        return "ERROR: No valid active window";
      }
      
      SetForegroundWindow(activeWindow);
      Thread.Sleep(50);
      
      var ctrlDown = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL } } };
      var vDown = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_V } } };
      var vUp = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_V, dwFlags = KEYEVENTF_KEYUP } } };
      var ctrlUp = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL, dwFlags = KEYEVENTF_KEYUP } } };
      
      uint result1 = SendInput(1, new INPUT[] { ctrlDown }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(10);
      uint result2 = SendInput(1, new INPUT[] { vDown }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(10);
      uint result3 = SendInput(1, new INPUT[] { vUp }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(10);
      uint result4 = SendInput(1, new INPUT[] { ctrlUp }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
      
      return $"SendInput-SUCCESS: {result1},{result2},{result3},{result4}";
    } catch (Exception ex) {
      return $"SendInput-ERROR: {ex.Message}";
    }
  }
}
'@
    Add-Type -TypeDefinition $code -Language CSharp
    $result = [K]::Paste()
    Write-Output $result
  } catch {
    Write-Output "SendInput-FAILED: $($_.Exception.Message)"
  }
}`.trim();
    }
    
    const pr = spawn('powershell.exe', 
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
      { windowsHide: true });
    
    let output = '';
    let errorOutput = '';
    
    pr.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    pr.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    pr.on('exit', (code) => {
      dlog(`keystroke:${keys}:result`, { 
        exitCode: code, 
        output: output.trim(), 
        error: errorOutput.trim() || null 
      });
      resolve();
    });
    
    pr.on('error', (err) => {
      dlog(`keystroke:${keys}:error`, { error: err.message });
      resolve();
    });
  });
}

async function updateShortcutsFile() {
  if (!shortcutsFilePath) return;
  
  try {
    // Get current shortcuts mapping
    const mapping = getShortcutsMapping();
    
    // Create reverse mapping from shortcut keyword to item ID
    const shortcutsData = {};
    Object.keys(mapping).forEach(keyword => {
      const itemId = mapping[keyword];
      shortcutsData[keyword] = itemId;
    });
    
    // Write to JSON file for AHK to read
    await fsp.writeFile(shortcutsFilePath, JSON.stringify(shortcutsData, null, 2), 'utf8');
    dlog('shortcuts:file:updated', { count: Object.keys(shortcutsData).length, path: shortcutsFilePath });
    
  } catch (error) {
    dlog('shortcuts:file:error', { error: error.message });
  }
}

// AHK functions removed - using Electron global shortcuts instead

function updateShortcutMapping(itemId, oldShortcut, newShortcut) {
  const mapping = getShortcutsMapping();
  
  // Remove old shortcut if exists
  if (oldShortcut && mapping[oldShortcut] === itemId) {
    delete mapping[oldShortcut];
  }
  
  // Add new shortcut if provided
  if (newShortcut) {
    // Remove any existing mapping for this shortcut (enforce uniqueness)
    Object.keys(mapping).forEach(key => {
      if (mapping[key] === itemId || key === newShortcut) {
        delete mapping[key];
      }
    });
    mapping[newShortcut] = itemId;
  }
  
  setShortcutsMapping(mapping);
  dlog('shortcut:mapping', { oldShortcut, newShortcut, itemId, totalShortcuts: Object.keys(mapping).length });
  
  // Update shortcuts file for AHK
  updateShortcutsFile().catch(err => {
    dlog('shortcut:file:update:error', { error: err.message });
  });
}

function cleanupShortcuts(validItemIds) {
  const mapping = getShortcutsMapping();
  const validSet = new Set(validItemIds);
  let changed = false;
  
  Object.keys(mapping).forEach(shortcut => {
    if (!validSet.has(mapping[shortcut])) {
      delete mapping[shortcut];
      changed = true;
    }
  });
  
  if (changed) {
    setShortcutsMapping(mapping);
    dlog('shortcut:cleanup', { removedOrphans: changed });
    
    // Update shortcuts file for AHK
    updateShortcutsFile().catch(err => {
      dlog('shortcut:file:cleanup:error', { error: err.message });
    });
  }
}

function broadcastCollections() {
  try { overlayWin?.webContents?.send('collections:update', getCollections()); } catch {}
}

ipcMain.handle('collections:list', () => getCollections());

ipcMain.handle('collections:create', (_e, name) => {
  const list = getCollections();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const col = {
    id,
    name: String(name || 'New collection').trim() || 'New collection',
    itemIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  list.push(col);
  setCollections(list);
  broadcastCollections();
  return col;
});

ipcMain.handle('collections:rename', (_e, { id, name }) => {
  const list = getCollections();
  const col = list.find(c => c.id === id);
  if (!col) return false;
  col.name = String(name || col.name);
  col.updatedAt = new Date().toISOString();
  setCollections(list);
  broadcastCollections();
  return true;
});

ipcMain.handle('collections:delete', (_e, id) => {
  let list = getCollections();
  const before = list.length;
  list = list.filter(c => c.id !== id);
  setCollections(list);
  broadcastCollections();
  return list.length < before;
});

ipcMain.handle('collections:addItems', (_e, { id, itemIds }) => {
  const list = getCollections();
  const col = list.find(c => c.id === id);
  if (!col) return false;
  const s = new Set(col.itemIds || []);
  (itemIds || []).forEach(x => s.add(x));
  col.itemIds = Array.from(s);
  col.updatedAt = new Date().toISOString();
  setCollections(list);
  broadcastCollections();
  return true;
});

ipcMain.handle('collections:removeItems', (_e, { id, itemIds }) => {
  const list = getCollections();
  const col = list.find(c => c.id === id);
  if (!col) return false;
  const rem = new Set(itemIds || []);
  col.itemIds = (col.itemIds || []).filter(x => !rem.has(x));
  col.updatedAt = new Date().toISOString();
  setCollections(list);
  broadcastCollections();
  return true;
});

// --- Stack paste: always hide overlay, set clipboard, then paste ---
ipcMain.handle('stack:pasteNext', async (_e, data) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    console.log('[stack] pasteNext: incoming', {
      hasText: !!data?.text,
      hasImagePath: !!data?.imagePath,
      hasImageDataUrl: !!data?.imageDataUrl
    });

    // 1) Hide overlay so target app regains focus
    try {
      if (overlayWin && overlayWin.isVisible()) {
        console.log('[stack] pasteNext: hiding overlay for focus…');
        overlayWin.hide();
      }
    } catch (e) { console.log('[stack] overlay hide warn:', e?.message); }

    // Give Windows a moment to refocus the last active app
    await sleep(120);

    // 2) Set clipboard
    if (data?.text) {
      clipboard.writeText(String(data.text));
      console.log('[stack] pasteNext: wrote TEXT len=', String(data.text).length);
    } else if (data?.imagePath) {
      try {
        const img = nativeImage.createFromPath(data.imagePath);
        if (!img.isEmpty()) {
          clipboard.writeImage(img);
          console.log('[stack] pasteNext: wrote IMAGE from path');
        } else {
          console.log('[stack] pasteNext: image from path was empty');
        }
      } catch (e) {
        console.log('[stack] pasteNext: imagePath error', e?.message);
      }
    } else if (data?.imageDataUrl) {
      try {
        const img = nativeImage.createFromDataURL(data.imageDataUrl);
        if (!img.isEmpty()) {
          clipboard.writeImage(img);
          console.log('[stack] pasteNext: wrote IMAGE from dataURL');
        } else {
          console.log('[stack] pasteNext: image from dataURL was empty');
        }
      } catch (e) {
        console.log('[stack] pasteNext: dataURL error', e?.message);
      }
    }

    // Tiny settle time before sending Ctrl+V
    await sleep(40);

    // 3) Paste keystroke (your existing function)
    console.log('[stack] pasteNext: sending paste keystroke…');
    pasteKeystroke();

    return true;
  } catch (e) {
    console.log('[stack] pasteNext: ERROR', e?.message);
    return false;
  }
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
  // overlaySize removed
  enableTextShortcuts: settingsStore.get('enableTextShortcuts'),
  shortcutTriggerPrefix: settingsStore.get('shortcutTriggerPrefix'),
  shortcutCaseSensitive: settingsStore.get('shortcutCaseSensitive'),
  shortcutMinLength: settingsStore.get('shortcutMinLength'),
  showShortcutNotifications: settingsStore.get('showShortcutNotifications'),
  smartPasteHotkey: settingsStore.get('smartPasteHotkey'),
  enableSmartPaste: settingsStore.get('enableSmartPaste'),
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
  // overlaySize setting removed - using single fixed size
  
  // Text shortcuts settings
  if (Object.prototype.hasOwnProperty.call(s, 'enableTextShortcuts')) {
    settingsStore.set('enableTextShortcuts', !!s.enableTextShortcuts);
  }
  if (Object.prototype.hasOwnProperty.call(s, 'shortcutCaseSensitive')) {
    settingsStore.set('shortcutCaseSensitive', !!s.shortcutCaseSensitive);
  }
  if (Object.prototype.hasOwnProperty.call(s, 'showShortcutNotifications')) {
    settingsStore.set('showShortcutNotifications', !!s.showShortcutNotifications);
  }
  if (Object.prototype.hasOwnProperty.call(s, 'shortcutMinLength')) {
    settingsStore.set('shortcutMinLength', Math.max(1, Math.min(10, parseInt(s.shortcutMinLength || 2, 10))));
  }
  if (Object.prototype.hasOwnProperty.call(s, 'shortcutTriggerPrefix')) {
    const prefix = String(s.shortcutTriggerPrefix || '//').trim();
    settingsStore.set('shortcutTriggerPrefix', prefix || '//');
  }
  if (Object.prototype.hasOwnProperty.call(s, 'smartPasteHotkey')) {
    const hotkey = String(s.smartPasteHotkey || 'Ctrl+Space').trim();
    settingsStore.set('smartPasteHotkey', hotkey || 'Ctrl+Space');
  }
  if (Object.prototype.hasOwnProperty.call(s, 'enableSmartPaste')) {
    settingsStore.set('enableSmartPaste', !!s.enableSmartPaste);
  }
  
  registerHotkey();

  if (settingsStore.get('captureContext')) {
    await startActiveWinSampling();
  } else {
    stopActiveWinSampling();
  }
  
  // Restart text monitoring if settings changed
  stopTextMonitoring();
  startTextMonitoring();
  
  // Update expansion hotkey
  registerExpansionHotkey();
  
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
    
    // Initialize shortcuts file
    await initShortcutsFile();
    
    // Cleanup orphaned shortcuts on startup
    const items = historyStore.get('items') || [];
    const validIds = items.map(i => i.id);
    cleanupShortcuts(validIds);
    
    createOverlay();
    registerHotkey();
    startClipboardPolling();
    if (settingsStore.get('captureContext')) await startActiveWinSampling();
    startTextMonitoring();
    
    // Register expansion hotkey
    if (settingsStore.get('enableTextShortcuts') && settingsStore.get('enableSmartPaste')) {
      registerExpansionHotkey();
    }
  });
  app.on('will-quit', () => { 
    globalShortcut.unregisterAll(); 
    stopActiveWinSampling(); 
    stopTextMonitoring();
  });
}
