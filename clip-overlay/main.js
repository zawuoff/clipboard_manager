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
let clipboardCheckCount = 0;
let adaptiveInterval = 200; // Start with 200ms, can adapt
const MIN_INTERVAL = 100;
const MAX_INTERVAL = 1000;
const IDLE_THRESHOLD = 50; // After 50 unchanged checks, slow down

// Performance monitoring
let perfStats = {
  pollsPerSecond: 0,
  avgPollTime: 0,
  totalPolls: 0,
  lastResetTime: Date.now()
};

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

// Enhanced OCR processing with worker pool and smart queue management
let ocrWorkerPool = [];
let ocrQueue = [];
let isProcessingOcr = false;
let ocrStats = {
  totalProcessed: 0,
  avgProcessingTime: 0,
  successRate: 0,
  errors: 0
};

const OCR_CONFIG = {
  maxWorkers: 2,           // Maximum number of worker instances
  queueLimit: 10,          // Maximum queue size
  workerTimeout: 30000,    // Worker timeout in ms
  retryAttempts: 2,        // Retry failed OCR operations
  cleanupInterval: 300000  // Cleanup interval (5 minutes)
};

async function createOcrWorker() {
  const found = resolveEngData();
  if (!found) throw new Error('ENG model not found');
  
  dlog('ocr:worker:create', found);
  const worker = await createWorker('eng', undefined, {
    langPath: found.dir,
    gzip: found.gzip,
    cachePath: path.join(app.getPath('userData'), 'tess-cache'),
    workerBlobURL: false,
  });
  
  return {
    worker,
    busy: false,
    created: Date.now(),
    lastUsed: Date.now(),
    tasksCompleted: 0
  };
}

async function getOcrWorkerFromPool() {
  // Find available worker
  let workerInstance = ocrWorkerPool.find(w => !w.busy);
  
  if (!workerInstance && ocrWorkerPool.length < OCR_CONFIG.maxWorkers) {
    // Create new worker if pool not full
    try {
      workerInstance = await createOcrWorker();
      ocrWorkerPool.push(workerInstance);
      dlog('ocr:pool:add', { poolSize: ocrWorkerPool.length });
    } catch (e) {
      dlog('ocr:worker:create:error', { msg: e?.message });
      return null;
    }
  }
  
  if (!workerInstance) {
    // No available workers, wait for one
    return null;
  }
  
  workerInstance.busy = true;
  workerInstance.lastUsed = Date.now();
  return workerInstance;
}

function releaseOcrWorker(workerInstance) {
  workerInstance.busy = false;
  workerInstance.tasksCompleted++;
  workerInstance.lastUsed = Date.now();
}

async function processOcrQueue() {
  if (isProcessingOcr) return;
  isProcessingOcr = true;
  
  const processTask = async (task) => {
    const startTime = Date.now();
    let attempts = 0;
    
    while (attempts <= OCR_CONFIG.retryAttempts) {
      const workerInstance = await getOcrWorkerFromPool();
      if (!workerInstance) {
        // No workers available, requeue for later
        setTimeout(() => processOcrQueue(), 1000);
        return;
      }
      
      try {
        const buf = await fsp.readFile(task.filePath);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('OCR timeout')), OCR_CONFIG.workerTimeout)
        );
        
        const recognizePromise = workerInstance.worker.recognize(buf);
        const { data } = await Promise.race([recognizePromise, timeoutPromise]);
        const text = (data?.text || '').trim();
        
        if (text) {
          const itemsNow = historyStore.get('items') || [];
          const idx = itemsNow.findIndex(i => i.id === task.id);
          if (idx >= 0) {
            const addTags = autoTagsForText(text);
            const existing = Array.from(new Set(itemsNow[idx].tags || []));
            itemsNow[idx].ocrText = text.length > 12000 ? text.slice(0, 12000) : text;
            itemsNow[idx].tags = Array.from(new Set([...existing, ...addTags, 'ocr']));
            
            // Update header with OCR-enhanced analysis (only if still default/generic)
            const currentHeader = itemsNow[idx].header || 'Untitled';
            const isGenericHeader = currentHeader === 'Untitled' || 
                                  currentHeader === 'Image' || 
                                  currentHeader === 'Screenshot' ||
                                  currentHeader.endsWith(' Screenshot');
            
            if (isGenericHeader) {
              const enhancedHeader = generateImageHeader(text, itemsNow[idx].source, itemsNow[idx].wh);
              if (enhancedHeader && enhancedHeader !== currentHeader) {
                itemsNow[idx].header = truncateHeader(enhancedHeader);
                headerStats.ocrUpdates++;
                dlog('header:ocr:update', { 
                  id: task.id, 
                  old: currentHeader, 
                  new: itemsNow[idx].header 
                });
              }
            }
            
            historyStore.set('items', itemsNow);
            overlayWin?.webContents?.send('history:update', itemsNow);
            
            const processingTime = Date.now() - startTime;
            ocrStats.totalProcessed++;
            ocrStats.avgProcessingTime = (ocrStats.avgProcessingTime + processingTime) / 2;
            ocrStats.successRate = (ocrStats.totalProcessed / (ocrStats.totalProcessed + ocrStats.errors)) * 100;
            
            dlog('ocr:done', { 
              id: task.id, 
              tags: addTags, 
              processingTime,
              attempts: attempts + 1,
              headerUpdated: isGenericHeader
            });
          }
        }
        
        releaseOcrWorker(workerInstance);
        return; // Success, exit retry loop
        
      } catch (e) {
        releaseOcrWorker(workerInstance);
        attempts++;
        ocrStats.errors++;
        
        if (attempts > OCR_CONFIG.retryAttempts) {
          dlog('ocr:error:final', { 
            msg: e?.message, 
            id: task.id, 
            attempts 
          });
        } else {
          dlog('ocr:error:retry', { 
            msg: e?.message, 
            id: task.id, 
            attempt: attempts 
          });
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); // Exponential backoff
        }
      }
    }
  };
  
  // Process queue with concurrency control
  const concurrentTasks = [];
  while (ocrQueue.length > 0 && concurrentTasks.length < OCR_CONFIG.maxWorkers) {
    const task = ocrQueue.shift();
    concurrentTasks.push(processTask(task));
  }
  
  if (concurrentTasks.length > 0) {
    await Promise.allSettled(concurrentTasks);
  }
  
  isProcessingOcr = false;
  
  // Continue processing if queue not empty
  if (ocrQueue.length > 0) {
    setTimeout(() => processOcrQueue(), 100);
  }
}

// Cleanup idle workers periodically
setInterval(() => {
  const now = Date.now();
  ocrWorkerPool = ocrWorkerPool.filter(workerInstance => {
    if (!workerInstance.busy && (now - workerInstance.lastUsed) > OCR_CONFIG.cleanupInterval) {
      try {
        workerInstance.worker.terminate();
        dlog('ocr:worker:cleanup', { 
          age: now - workerInstance.created,
          tasksCompleted: workerInstance.tasksCompleted 
        });
      } catch (e) {
        dlog('ocr:worker:cleanup:error', { msg: e?.message });
      }
      return false; // Remove from pool
    }
    return true; // Keep in pool
  });
}, OCR_CONFIG.cleanupInterval);

// Graceful shutdown
process.on('exit', () => {
  ocrWorkerPool.forEach(workerInstance => {
    try {
      workerInstance.worker.terminate();
    } catch (e) {
      // Ignore errors during shutdown
    }
  });
});

function updatePerfStats() {
  const now = Date.now();
  const elapsed = now - perfStats.lastResetTime;
  
  if (elapsed >= 5000) { // Reset every 5 seconds
    perfStats.pollsPerSecond = (perfStats.totalPolls * 1000) / elapsed;
    perfStats.lastResetTime = now;
    perfStats.totalPolls = 0;
    
    if (settingsStore?.get('debugLogging')) {
      dlog('perf:clipboard', {
        pollsPerSecond: Math.round(perfStats.pollsPerSecond * 100) / 100,
        adaptiveInterval,
        avgPollTime: Math.round(perfStats.avgPollTime * 100) / 100
      });
    }
  }
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

/* ---------- Smart Header Generation System ---------- */
const HEADER_PATTERNS = {
  // URLs - extract meaningful domain/page info
  url: /^https?:\/\/(?:www\.)?([^\/\s]+)/i,
  
  // Communication
  email: /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
  phone: /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/,
  
  // Dates and Times
  meetingTime: /\b(?:meeting|call|conference|sync|standup|scrum).{0,50}?\b(?:at\s+)?(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)/i,
  dateTime: /\b(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}-\d{2,4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/i,
  time: /\b(\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))\b/i,
  
  // Addresses and Locations
  address: /\b\d+\s+[A-Za-z0-9\s]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|way)\b/i,
  
  // Code patterns
  codeFunction: /(?:function|def|const|let|var|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  codeLang: {
    javascript: /\b(?:function|const|let|var|=>|console\.log|require|import|export)\b/,
    python: /\b(?:def|import|from|print|if __name__|class|lambda)\b/,
    css: /\{[^}]*(?:color|background|margin|padding|font|border)[^}]*\}/,
    html: /<\/?[a-z][\s\S]*?>/i,
    sql: /\b(?:select|insert|update|delete|create|drop|alter|from|where|join)\b/i,
    json: /^\s*[\{\[][\s\S]*[\}\]]\s*$/
  },
  
  // Content types
  task: /(?:todo|task|checklist|reminder|pick up|call|finish|complete|buy|get|do)/i,
  note: /(?:note|remember|important|fyi|heads up|reminder)/i,
  invoice: /\b(?:invoice|bill|receipt|order)\s*#?(\w+)/i,
  
  // Common content starters
  meeting: /\b(?:meeting|call|conference|sync|standup|scrum|demo)\b/i,
  howTo: /\b(?:how\s+to|tutorial|guide|instructions|steps)/i
};

function generateSmartHeader(item) {
  const startTime = performance.now();
  let header = 'Untitled';
  
  try {
    if (item.type === 'text') {
      header = generateTextHeader(item.text, item.source);
      headerStats.textHeaders++;
    } else if (item.type === 'image') {
      header = generateImageHeader(item.ocrText, item.source, item.wh);
      headerStats.imageHeaders++;
    }
    
    headerStats.totalGenerated++;
    const generationTime = performance.now() - startTime;
    headerStats.avgGenerationTime = (headerStats.avgGenerationTime + generationTime) / 2;
    
    return header;
  } catch (e) {
    dlog('header:generation:error', { msg: e?.message, type: item.type });
    return 'Untitled';
  }
}

function generateTextHeader(text, source) {
  const t = String(text || '').trim();
  if (!t) return 'Untitled';
  
  try {
    // STEP 1: Context-First Analysis (HIGHEST PRIORITY)
    const contextHeader = analyzeSourceContext(t, source);
    if (contextHeader) return contextHeader;
    
    // STEP 2: Content Analysis - What is this PRIMARILY about?
    const contentType = analyzePrimaryContent(t);
    
    // STEP 3: Generate header based on primary content type
    switch (contentType.type) {
      case 'single_url':
        return generateUrlHeader(contentType.data);
        
      case 'single_email':
        return generateEmailHeader(contentType.data);
        
      case 'single_phone':
        return 'Phone Number';
        
      case 'code':
        return generateCodeHeader(t, contentType.confidence);
        
      case 'meeting':
        return generateMeetingHeader(t);
        
      case 'document':
        return extractDocumentTitle(t);
        
      case 'list':
        return generateListHeader(t);
        
      case 'conversation':
        return 'Chat Messages';
        
      default:
        // STEP 4: Smart summarization for everything else
        return extractSmartSummary(t);
    }
    
  } catch (e) {
    dlog('header:text:error', { msg: e?.message, textLength: t.length });
    return extractSmartSummary(t) || 'Text Content';
  }
}

// Context-first analysis - prioritize window/app info
function analyzeSourceContext(text, source) {
  if (!source || !source.app) return null;
  
  const app = source.app.toLowerCase();
  const title = (source.title || '').toLowerCase();
  const textLen = text.length;
  
  // VS Code / IDEs - likely code
  if (app.includes('code') || app.includes('visual studio') || app.includes('atom') || app.includes('sublime')) {
    if (looksLikeCode(text)) {
      const lang = detectCodeLanguage(text) || 'Code';
      const func = extractMainFunction(text);
      return func ? `${lang} - ${func}` : `${lang} Snippet`;
    }
    return 'Code Editor Text';
  }
  
  // Browser with meaningful title
  if ((app.includes('chrome') || app.includes('firefox') || app.includes('edge') || app.includes('safari')) && title) {
    const cleanTitle = title.replace(/ - (google chrome|mozilla firefox|microsoft edge|safari)/gi, '');
    if (cleanTitle.length > 5 && cleanTitle.length < 60) {
      return extractKeyWordsFromTitle(cleanTitle);
    }
  }
  
  // Communication apps
  if (app.includes('slack') || app.includes('discord') || app.includes('teams')) {
    return isLongText(text) ? extractSmartSummary(text) : 'Chat Message';
  }
  
  // Email clients
  if (app.includes('outlook') || app.includes('mail') || app.includes('thunderbird')) {
    return isLongText(text) ? extractSmartSummary(text) : 'Email Content';
  }
  
  // Document editors
  if (app.includes('word') || app.includes('notepad') || app.includes('obsidian') || app.includes('notion')) {
    return extractDocumentTitle(text);
  }
  
  return null; // No strong context clues
}

// Analyze what the content is PRIMARILY about
function analyzePrimaryContent(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const wordCount = text.split(/\s+/).length;
  
  // Single-purpose content (high confidence)
  if (wordCount <= 10) {
    if (HEADER_PATTERNS.url.test(text.trim()) && text.trim().split(/\s+/).length <= 2) {
      return { type: 'single_url', data: text.trim(), confidence: 0.95 };
    }
    if (HEADER_PATTERNS.email.test(text.trim()) && text.trim().split(/\s+/).length <= 2) {
      return { type: 'single_email', data: text.trim(), confidence: 0.95 };
    }
    if (HEADER_PATTERNS.phone.test(text.trim()) && text.trim().split(/\s+/).length <= 2) {
      return { type: 'single_phone', confidence: 0.95 };
    }
  }
  
  // Code analysis (check proportion)
  const codeIndicators = countCodeIndicators(text);
  const codeRatio = codeIndicators / Math.max(1, wordCount / 10); // Code indicators per 10 words
  if (codeRatio > 0.3 || (looksLikeCode(text) && wordCount < 100)) {
    return { type: 'code', confidence: Math.min(0.95, codeRatio) };
  }
  
  // Meeting/event content
  if (HEADER_PATTERNS.meeting.test(text) && (text.includes('time') || text.includes('pm') || text.includes('am'))) {
    return { type: 'meeting', confidence: 0.8 };
  }
  
  // List detection
  if (lines.length >= 3 && isListStructure(text)) {
    return { type: 'list', confidence: 0.8 };
  }
  
  // Conversation detection
  if (isConversationStructure(text)) {
    return { type: 'conversation', confidence: 0.7 };
  }
  
  // Document/article (longer content)
  if (wordCount > 50) {
    return { type: 'document', confidence: 0.6 };
  }
  
  return { type: 'general', confidence: 0.3 };
}

// Extract main topic/theme from text (2-3 words max)
function extractSmartSummary(text) {
  const words = text.split(/\s+/);
  
  // For very short text, use first meaningful words
  if (words.length <= 6) {
    return extractKeyWords(text).slice(0, 3).join(' ') || capitalizeWords(words.slice(0, 3));
  }
  
  // For longer text, extract key themes
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length > 0) {
    // Try to extract from first meaningful sentence
    const firstSentence = sentences[0].trim();
    const keyWords = extractKeyWords(firstSentence);
    if (keyWords.length >= 2) {
      return keyWords.slice(0, 3).join(' ');
    }
  }
  
  // Extract most frequent meaningful words
  const wordFreq = getWordFrequency(text);
  const topWords = Object.entries(wordFreq)
    .filter(([word]) => word.length > 3 && !isStopWord(word))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => capitalizeFirst(word));
  
  return topWords.length > 0 ? topWords.join(' ') : capitalizeWords(words.slice(0, 3));
}

// Helper functions
function isLongText(text) {
  return text.split(/\s+/).length > 50;
}

function countCodeIndicators(text) {
  const codePatterns = [
    /function\s+\w+/gi, /const\s+\w+/gi, /let\s+\w+/gi, /var\s+\w+/gi,
    /class\s+\w+/gi, /import\s+/gi, /export\s+/gi, /require\(/gi,
    /console\.log/gi, /if\s*\(/gi, /for\s*\(/gi, /while\s*\(/gi,
    /{\s*$/gm, /;\s*$/gm, /=>/gi, /\w+\.\w+\(/gi
  ];
  
  return codePatterns.reduce((count, pattern) => {
    const matches = text.match(pattern) || [];
    return count + matches.length;
  }, 0);
}

function isListStructure(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const listIndicators = lines.filter(line => 
    /^\s*[-*•]\s/.test(line) || 
    /^\s*\d+[.)]\s/.test(line) ||
    /^\s*[a-zA-Z][.)]\s/.test(line)
  );
  
  return listIndicators.length / lines.length > 0.5;
}

function isConversationStructure(text) {
  const lines = text.split('\n');
  const messageIndicators = lines.filter(line =>
    /^\w+:\s/.test(line) || // "Name: message"
    /^\[\d+:\d+\]/.test(line) || // Timestamps
    /^>\s/.test(line) // Quoted messages
  );
  
  return messageIndicators.length >= 2;
}

function extractMainFunction(text) {
  const match = text.match(HEADER_PATTERNS.codeFunction);
  return match ? match[1] : null;
}

function generateUrlHeader(url) {
  const match = url.match(HEADER_PATTERNS.url);
  if (!match) return 'URL';
  
  const domain = match[1].toLowerCase();
  const mainDomain = domain.split('.').slice(-2)[0];
  
  const domainMap = {
    'github': 'GitHub',
    'youtube': 'YouTube',
    'stackoverflow': 'Stack Overflow',
    'linkedin': 'LinkedIn',
    'twitter': 'Twitter',
    'medium': 'Medium',
    'docs': 'Documentation'
  };
  
  return domainMap[mainDomain] || capitalizeFirst(mainDomain);
}

function generateEmailHeader(email) {
  const domain = email.split('@')[1];
  if (!domain) return 'Email';
  
  const company = domain.split('.')[0];
  return company.length < 15 ? capitalizeFirst(company) + ' Email' : 'Email';
}

function generateCodeHeader(text, confidence) {
  const lang = detectCodeLanguage(text);
  const func = extractMainFunction(text);
  
  if (func && confidence > 0.7) {
    return lang ? `${lang} - ${func}` : `Code - ${func}`;
  }
  
  return lang || 'Code';
}

function generateMeetingHeader(text) {
  const timeMatch = text.match(HEADER_PATTERNS.time);
  if (timeMatch) {
    return `Meeting ${timeMatch[1]}`;
  }
  return 'Meeting';
}

function extractDocumentTitle(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return extractSmartSummary(text);
  
  // Try first line if it looks like a title
  const firstLine = lines[0].trim();
  if (firstLine.length > 5 && firstLine.length < 50 && !firstLine.endsWith('.')) {
    const words = extractKeyWords(firstLine);
    if (words.length > 0) {
      return words.slice(0, 3).join(' ');
    }
  }
  
  return extractSmartSummary(text);
}

function generateListHeader(text) {
  const firstItem = text.split('\n').find(line => 
    /^\s*[-*•]\s(.+)/.test(line) || 
    /^\s*\d+[.)]\s(.+)/.test(line)
  );
  
  if (firstItem) {
    const content = firstItem.replace(/^\s*[-*•\d+.)]\s*/, '').trim();
    const words = extractKeyWords(content).slice(0, 2);
    return words.length > 0 ? words.join(' ') + ' List' : 'List';
  }
  
  return 'List';
}

function extractKeyWordsFromTitle(title) {
  const cleaned = title.replace(/[^\w\s-]/g, ' ').trim();
  const words = extractKeyWords(cleaned);
  return words.slice(0, 3).join(' ') || cleaned.split(/\s+/).slice(0, 3).join(' ');
}

function getWordFrequency(text) {
  const words = text.toLowerCase().match(/\b\w{4,}\b/g) || [];
  const freq = {};
  words.forEach(word => {
    if (!isStopWord(word)) {
      freq[word] = (freq[word] || 0) + 1;
    }
  });
  return freq;
}

function isStopWord(word) {
  const stopWords = new Set([
    'this', 'that', 'with', 'have', 'will', 'been', 'were', 'said', 'each', 'which',
    'their', 'time', 'would', 'there', 'could', 'other', 'after', 'first', 'well',
    'also', 'very', 'what', 'know', 'just', 'work', 'life', 'only', 'new', 'way'
  ]);
  return stopWords.has(word.toLowerCase());
}

function capitalizeWords(words) {
  return words.filter(w => w && w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function generateImageHeader(ocrText, source, dimensions) {
  try {
    // 1. OCR-based analysis (primary)
    if (ocrText && ocrText.trim()) {
      const header = analyzeOCRForHeader(ocrText, source);
      if (header && header !== 'Untitled') {
        return header;
      }
    }
    
    // 2. Source app context (secondary)
    if (source && source.app) {
      const appName = source.app.toLowerCase();
      
      // App-specific headers
      const appHeaders = {
        'code': 'Code Screenshot',
        'visual studio code': 'VS Code Screenshot',
        'vscode': 'VS Code Screenshot',
        'chrome': 'Web Screenshot',
        'firefox': 'Web Screenshot',
        'edge': 'Web Screenshot',
        'safari': 'Web Screenshot',
        'figma': 'Design Screenshot',
        'sketch': 'Design Screenshot',
        'photoshop': 'Photoshop Screenshot',
        'slack': 'Slack Screenshot',
        'discord': 'Discord Screenshot',
        'teams': 'Teams Screenshot',
        'zoom': 'Zoom Screenshot',
        'terminal': 'Terminal Screenshot',
        'cmd': 'Command Prompt',
        'powershell': 'PowerShell Screenshot'
      };
      
      for (const [key, value] of Object.entries(appHeaders)) {
        if (appName.includes(key)) {
          return value;
        }
      }
      
      // Browser with title context
      if (source.title && (appName.includes('chrome') || appName.includes('firefox') || appName.includes('edge'))) {
        const cleanTitle = source.title.replace(/ - Google Chrome| - Mozilla Firefox| - Microsoft Edge/gi, '');
        const titleWords = extractKeyWords(cleanTitle).slice(0, 3);
        if (titleWords.length > 0) {
          return titleWords.join(' ') + ' - Web';
        }
      }
      
      // Generic app screenshot
      const cleanAppName = capitalizeFirst(appName.replace(/\.exe$/i, ''));
      return `${cleanAppName} Screenshot`;
    }
    
    // 3. Dimension-based fallback
    if (dimensions) {
      const { w, h } = dimensions;
      if (w < 200 && h < 200) {
        return 'Icon/Small Image';
      }
      if (w > 1200 || h > 800) {
        return 'Screenshot';
      }
    }
    
    return 'Image';
    
  } catch (e) {
    dlog('header:image:error', { msg: e?.message });
    return 'Image';
  }
}

function analyzeOCRForHeader(ocrText, source) {
  const text = String(ocrText).trim();
  if (!text) return null;
  
  try {
    // Look for code patterns in OCR
    if (looksLikeCode(text)) {
      const funcMatch = text.match(HEADER_PATTERNS.codeFunction);
      if (funcMatch) {
        return `Code - ${funcMatch[1]}()`;
      }
      
      const lang = detectCodeLanguage(text);
      if (lang) {
        return `${lang} Code Screenshot`;
      }
      return 'Code Screenshot';
    }
    
    // Look for email/web content
    if (text.includes('@') && text.includes('.com')) {
      return 'Email Screenshot';
    }
    
    if (text.match(/https?:\/\//)) {
      return 'Web Page Screenshot';
    }
    
    // Look for document titles (first meaningful line)
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    if (lines.length > 0) {
      const firstLine = lines[0].trim();
      
      // Skip common UI elements
      const skipPatterns = /^(home|back|next|previous|menu|settings|file|edit|view|help|ok|cancel|close|save|open)$/i;
      if (!skipPatterns.test(firstLine) && firstLine.length > 3 && firstLine.length < 50) {
        const words = extractKeyWords(firstLine);
        if (words.length > 0) {
          return words.slice(0, 4).join(' ');
        }
      }
    }
    
    // Fallback to key words from OCR
    const keyWords = extractKeyWords(text);
    if (keyWords.length >= 2) {
      return keyWords.slice(0, 3).join(' ') + ' Screenshot';
    }
    
    return null;
  } catch (e) {
    dlog('header:ocr:error', { msg: e?.message });
    return null;
  }
}

// Helper functions
function detectCodeLanguage(text) {
  const patterns = HEADER_PATTERNS.codeLang;
  
  if (patterns.javascript.test(text)) return 'JavaScript';
  if (patterns.python.test(text)) return 'Python';
  if (patterns.css.test(text)) return 'CSS';
  if (patterns.html.test(text)) return 'HTML';
  if (patterns.sql.test(text)) return 'SQL';
  if (patterns.json.test(text)) return 'JSON';
  
  return null;
}

function extractKeyWords(text) {
  const words = String(text)
    .split(/\s+/)
    .map(w => w.replace(/[^\w\s]/g, ''))
    .filter(w => w.length > 2)
    .filter(w => !/^(the|and|or|but|in|on|at|to|for|of|with|by)$/i.test(w))
    .slice(0, 5)
    .map(capitalizeFirst);
    
  return words;
}

function extractParticipants(text) {
  // Simple extraction of names from meeting text
  const namePattern = /\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;
  const matches = text.match(namePattern);
  
  if (matches && matches.length <= 3) {
    return matches.slice(0, 2).join(' & ');
  }
  
  // Look for team mentions
  const teamPattern = /\b(design|engineering|marketing|sales|product|dev|team)\b/gi;
  const teamMatch = text.match(teamPattern);
  if (teamMatch) {
    return capitalizeFirst(teamMatch[0]) + ' Team';
  }
  
  return null;
}

function capitalizeFirst(str) {
  const s = String(str || '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function truncateHeader(header, maxLength = 50) {
  if (!header || header.length <= maxLength) return header;
  return header.slice(0, maxLength - 3) + '...';
}

function startClipboardPolling() {
  if (clipboardPollTimer) clearInterval(clipboardPollTimer);
  
  const pollClipboard = async () => {
    const pollStart = Date.now();
    perfStats.totalPolls++;
    
    try {
      let changed = false;
      
      // Check images first (typically faster)
      try {
        const img = readClipboardImageRobust();
        if (img && !img.isEmpty()) {
          const png = img.toPNG();
          const hash = sha1(png);
          if (hash !== lastImageHash) {
            lastImageHash = hash;
            changed = true;
            clipboardCheckCount = 0; // Reset idle counter
            
            const source = captureSourceIfEnabled();
            const id = Date.now();
            const meta = await persistImage(img, id);
            
            // Create initial item with smart header
            const newItem = { 
              id, 
              type: 'image', 
              pinned: false, 
              ts: new Date().toISOString(), 
              source, 
              tags: [], 
              ...meta 
            };
            
            // Generate initial header (without OCR text yet)
            const initialHeader = generateSmartHeader(newItem);
            newItem.header = truncateHeader(initialHeader);
            
            const items = historyStore.get('items') || [];
            items.unshift(newItem);
            sortItems(items);
            await enforceMaxAndCleanup(items);
            historyStore.set('items', items);
            overlayWin?.webContents?.send('history:update', items);
            dlog('capture:image', { 
              id, 
              filePath: meta.filePath, 
              wh: meta.wh, 
              header: newItem.header,
              source: source?.app || 'unknown'
            });

            // Queue OCR processing with overflow protection
            if (ocrQueue.length < OCR_CONFIG.queueLimit) {
              ocrQueue.push({ id, filePath: meta.filePath });
              processOcrQueue(); // Non-blocking
            } else {
              dlog('ocr:queue:overflow', { queueSize: ocrQueue.length, dropped: id });
            }
            
            perfStats.avgPollTime = (perfStats.avgPollTime + (Date.now() - pollStart)) / 2;
            return;
          }
        }
      } catch (e) {
        dlog('capture:image:error', { msg: e?.message });
      }

      // Check text
      const text = clipboard.readText();
      if (text && text.trim() && text !== lastClipboardText) {
        lastClipboardText = text;
        changed = true;
        clipboardCheckCount = 0; // Reset idle counter

        const source = captureSourceIfEnabled();
        const items = historyStore.get('items') || [];
        
        // Avoid duplicate consecutive text entries
        if (!items.length || items[0].type !== 'text' || items[0].text !== text) {
          const id = Date.now();
          const tags = autoTagsForText(text);
          
          // Create item with smart header
          const newItem = { 
            id, 
            type: 'text', 
            text, 
            pinned: false, 
            ts: new Date().toISOString(), 
            source, 
            tags 
          };
          
          // Generate smart header
          const smartHeader = generateSmartHeader(newItem);
          newItem.header = truncateHeader(smartHeader);
          
          items.unshift(newItem);
          sortItems(items);
          await enforceMaxAndCleanup(items);
          historyStore.set('items', items);
          overlayWin?.webContents?.send('history:update', items);
          dlog('capture:text', { id, tags, len: text.length, header: newItem.header });
        }
      }
      
      // Adaptive polling: slow down when idle
      if (!changed) {
        clipboardCheckCount++;
        if (clipboardCheckCount >= IDLE_THRESHOLD) {
          adaptiveInterval = Math.min(MAX_INTERVAL, adaptiveInterval * 1.2);
        }
      } else {
        adaptiveInterval = MIN_INTERVAL; // Speed up after activity
      }
      
      perfStats.avgPollTime = (perfStats.avgPollTime + (Date.now() - pollStart)) / 2;
      updatePerfStats();
      
    } catch (e) {
      dlog('clipboard:poll:error', { msg: e?.message });
    }
    
    // Schedule next poll with adaptive interval
    clipboardPollTimer = setTimeout(pollClipboard, adaptiveInterval);
  };
  
  // Start polling
  clipboardPollTimer = setTimeout(pollClipboard, adaptiveInterval);
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




// Header generation statistics
let headerStats = {
  totalGenerated: 0,
  textHeaders: 0,
  imageHeaders: 0,
  ocrUpdates: 0,
  avgGenerationTime: 0
};

// Performance monitoring API
ipcMain.handle('perf:getStats', () => ({
  clipboard: {
    pollsPerSecond: Math.round(perfStats.pollsPerSecond * 100) / 100,
    avgPollTime: Math.round(perfStats.avgPollTime * 100) / 100,
    adaptiveInterval,
    totalPolls: perfStats.totalPolls
  },
  ocr: {
    totalProcessed: ocrStats.totalProcessed,
    avgProcessingTime: Math.round(ocrStats.avgProcessingTime),
    successRate: Math.round(ocrStats.successRate * 100) / 100,
    errors: ocrStats.errors,
    queueSize: ocrQueue.length,
    workerPoolSize: ocrWorkerPool.length,
    activeWorkers: ocrWorkerPool.filter(w => w.busy).length
  },
  headers: {
    totalGenerated: headerStats.totalGenerated,
    textHeaders: headerStats.textHeaders,
    imageHeaders: headerStats.imageHeaders,
    ocrUpdates: headerStats.ocrUpdates,
    avgGenerationTime: Math.round(headerStats.avgGenerationTime * 100) / 100
  },
  memory: {
    usage: process.memoryUsage(),
    heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    external: Math.round(process.memoryUsage().external / 1024 / 1024)
  },
  app: {
    uptime: Math.round(process.uptime()),
    version: app.getVersion(),
    platform: process.platform
  }
}));

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
    const appStartTime = Date.now();
    dlog('app:ready:start', { userData: app.getPath('userData') });
    
    // Phase 1: Critical startup tasks (must complete before UI)
    const criticalTasks = [
      () => createOverlay(),
      () => registerHotkey(),
    ];
    
    for (const task of criticalTasks) {
      try {
        await task();
      } catch (e) {
        dlog('app:critical:error', { msg: e?.message });
      }
    }
    
    const criticalTime = Date.now() - appStartTime;
    dlog('app:critical:done', { time: criticalTime });
    
    // Phase 2: Background initialization (can happen after UI is ready)
    process.nextTick(async () => {
      try {
        // Start clipboard polling immediately
        startClipboardPolling();
        
        // Initialize other features in parallel
        const backgroundTasks = [
          initShortcutsFile,
          () => {
            const items = historyStore.get('items') || [];
            const validIds = items.map(i => i.id);
            cleanupShortcuts(validIds);
          },
          () => settingsStore.get('captureContext') ? startActiveWinSampling() : Promise.resolve(),
          startTextMonitoring,
          () => {
            if (settingsStore.get('enableTextShortcuts') && settingsStore.get('enableSmartPaste')) {
              registerExpansionHotkey();
            }
          }
        ];
        
        const results = await Promise.allSettled(backgroundTasks.map(task => 
          Promise.resolve().then(task)
        ));
        
        const errors = results.filter(r => r.status === 'rejected');
        if (errors.length > 0) {
          dlog('app:background:errors', { count: errors.length, errors: errors.map(e => e.reason?.message) });
        }
        
        const totalTime = Date.now() - appStartTime;
        dlog('app:ready:complete', { 
          criticalTime, 
          totalTime, 
          backgroundTasks: backgroundTasks.length,
          errors: errors.length 
        });
      } catch (e) {
        dlog('app:background:error', { msg: e?.message });
      }
    });
  });
  app.on('will-quit', () => { 
    globalShortcut.unregisterAll(); 
    stopActiveWinSampling(); 
    stopTextMonitoring();
  });
}
