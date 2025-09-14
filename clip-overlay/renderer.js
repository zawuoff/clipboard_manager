// renderer.js — full file (original features preserved + Collections + Quick Actions + Paste Stack + Paste All)
//abdul do you see this shit?
const $ = (sel) => document.querySelector(sel);

/* Core elements */
const overlayCard = $('.overlay');
const resultsEl   = $('#results');
const searchEl    = $('#search');
const settingsEl  = $('#settings');
const themeEl     = $('#theme');
const hotkeyEl    = $('#hotkey');
const maxItemsEl  = $('#maxItems');
const captureEl   = $('#captureContext');
const clearBtn    = $('#clearBtn');
const settingsBtn = $('#settingsBtn');
const saveBtn     = $('#saveSettings');
const closeBtn    = $('#closeSettings');
const refreshPerfBtn = $('#refreshPerfBtn');
const perfMonitorEl = $('#perfMonitor');

const searchModeEl  = $('#searchMode');
const fuzzyThreshEl = $('#fuzzyThreshold');

const autoPasteEl   = $('#autoPasteOnSelect'); // paste on select toggle
// overlay size select removed - using single fixed size

/* Text shortcuts elements */
const enableTextShortcutsEl = $('#enableTextShortcuts');
const shortcutTriggerPrefixEl = $('#shortcutTriggerPrefix');
const shortcutCaseSensitiveEl = $('#shortcutCaseSensitive');
const shortcutMinLengthEl = $('#shortcutMinLength');
const showShortcutNotificationsEl = $('#showShortcutNotifications');

/* Smart Paste elements */
const enableSmartPasteEl = $('#enableSmartPaste');
const smartPasteHotkeyEl = $('#smartPasteHotkey');

/* Sidebar tabs container */
const tabsEl = document.querySelector('.sidebar-tabs');

/* ---------- State ---------- */
let items = [];
let filtered = [];
let selectedIndex = 0;
let currentTab = localStorage.getItem('clip_tab') || 'recent';
let cfg = {
  theme: 'dark',
  hotkey: 'CommandOrControl+Shift+Space',
  maxItems: 500,
  captureContext: false,
  searchMode: 'fuzzy',
  fuzzyThreshold: 0.4,
  autoPasteOnSelect: true,
  // overlaySize removed
};

/* COLLECTIONS state */
let collections = [];

/* STACK state & elements */
let pasteStack = [];               // FIFO of item IDs
let pasteStackIds = new Set();
const stackChipEl = document.getElementById('stackChip');   // from overlay.html
const stackCountEl = document.getElementById('stackCount'); // from overlay.html

/* ---------- Utils ---------- */
function escapeHTML(s='') {
  return String(s).replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function trimOneLine(s='') {
  const t = s.trim().replace(/\s+/g,' ');
  return t.length>260 ? t.slice(0,260)+'…' : t;
}
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
function extractUrlFromText(text = "") {
  const m = String(text).match(URL_RE);
  if (!m) return null;
  let url = m[0];
  url = url.replace(/[)\]\}>,.;!?]+$/g, '');
  return url;
}
function isUrlItem(it) {
  return it.type === 'text' && URL_RE.test(String(it.text || ''));
}
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean).map(s => String(s).toLowerCase())));

/* ---------- Optimized Fuzzy matching with memoization ---------- */
const fuzzyMatchCache = new Map();
const MAX_CACHE_SIZE = 1000;
let cacheHits = 0;
let cacheMisses = 0;

function clearOldCacheEntries() {
  if (fuzzyMatchCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(fuzzyMatchCache.entries());
    // Remove oldest 25% of entries
    const toRemove = Math.floor(entries.length * 0.25);
    for (let i = 0; i < toRemove; i++) {
      fuzzyMatchCache.delete(entries[i][0]);
    }
  }
}

function fuzzyMatch(hayRaw = '', qRaw = '') {
  const hay = String(hayRaw);
  const q = String(qRaw);
  
  if (!q) return { score: 1, pos: new Set() };
  
  // Create cache key
  const cacheKey = `${hay.slice(0, 100)}|${q}`; // Limit haystack length for cache key
  
  // Check cache first
  if (fuzzyMatchCache.has(cacheKey)) {
    cacheHits++;
    return fuzzyMatchCache.get(cacheKey);
  }
  
  cacheMisses++;
  
  const hayL = hay.toLowerCase();
  const qL = q.toLowerCase();
  const len = hayL.length;
  const qlen = qL.length;

  let result;

  // Exact substring match (fastest path)
  const idx = hayL.indexOf(qL);
  if (idx >= 0) {
    const pos = new Set();
    for (let i = idx; i < idx + qlen && i < len; i++) pos.add(i);
    const startBonus = 1 - (idx / Math.max(1, len));
    const tightBonus = Math.min(1, qlen / Math.max(qlen, 12));
    const score = Math.min(1, 0.65 + 0.25 * startBonus + 0.10 * tightBonus);
    result = { score, pos };
  } else {
    // Fuzzy subsequence matching
    let i = 0, j = 0, first = -1, last = -1;
    const pos = new Set();
    
    while (i < len && j < qlen) {
      if (hayL[i] === qL[j]) {
        if (first < 0) first = i;
        last = i;
        pos.add(i);
        j++;
      }
      i++;
    }
    
    if (j < qlen) {
      result = { score: 0, pos: new Set() };
    } else {
      const span = (last - first + 1);
      const density = qlen / span;
      const startBonus = 1 - (first / Math.max(1, len));
      const gapPenalty = (span - qlen) / span;
      const score = Math.max(0, Math.min(1, 0.6 * density + 0.3 * startBonus + 0.1 * (1 - gapPenalty)));
      result = { score, pos };
    }
  }
  
  // Cache the result
  fuzzyMatchCache.set(cacheKey, result);
  clearOldCacheEntries();
  
  return result;
}

// Performance monitoring for search
let searchStats = {
  totalSearches: 0,
  avgSearchTime: 0,
  lastResetTime: Date.now()
};

function updateSearchStats(searchTime) {
  searchStats.totalSearches++;
  searchStats.avgSearchTime = (searchStats.avgSearchTime + searchTime) / 2;
  
  const now = Date.now();
  if (now - searchStats.lastResetTime > 10000) { // Log every 10 seconds
    if (cfg.debugLogging || (window.api && window.api.getSettings)) {
      console.log('[search:perf]', {
        avgSearchTime: Math.round(searchStats.avgSearchTime * 100) / 100,
        cacheHitRate: Math.round((cacheHits / (cacheHits + cacheMisses)) * 100),
        cacheSize: fuzzyMatchCache.size,
        totalSearches: searchStats.totalSearches
      });
    }
    searchStats.lastResetTime = now;
  }
}
function renderWithHighlights(text = '', posSet = new Set()) {
  if (!posSet || !posSet.size) return escapeHTML(text);
  let html = '';
  let inRun = false;
  for (let i = 0; i < text.length; i++) {
    const isHit = posSet.has(i);
    if (isHit && !inRun) { html += '<span class="hl">'; inRun = true; }
    if (!isHit && inRun) { html += '</span>'; inRun = false; }
    html += escapeHTML(text[i]);
  }
  if (inRun) html += '</span>';
  return html;
}

/* ---------- Search helpers ---------- */
function sortCombined(arr) {
  arr.sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    new Date(b.ts) - new Date(a.ts)
  );
}
function sortByScoreThenDefault(arr) {
  arr.sort((a, b) =>
    (b._score || 0) - (a._score || 0) ||
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    new Date(b.ts) - new Date(a.ts)
  );
}
function baseSearchTextForItem(it) {
  let searchText = '';
  
  if (it.type !== 'image') {
    searchText = String(it.text || '');
  } else {
    const dims = it.wh ? `${it.wh.w}x${it.wh.h}` : '';
    const meta = `${dims} ${it?.source?.app || ''} ${it?.source?.title || ''}`;
    searchText = (it.ocrText && it.ocrText.trim()) ? it.ocrText : meta;
  }
  
  // Include shortcut keyword in search text
  if (it.shortcut) {
    searchText += ` ${it.shortcut}`;
  }
  
  return searchText;
}

/* Smart query: tag/type/has/pinned/shortcut + free text */
function parseQuery(q) {
  const out = { text: [], include: [], exclude: [], type: null, hasOCR: null, pinned: null, hasShortcut: null };
  const parts = String(q || '').trim().split(/\s+/).filter(Boolean);
  for (const p of parts) {
    const mTag = p.match(/^(-)?tag:(.+)$/i);
    if (mTag) { (mTag[1] ? out.exclude : out.include).push(mTag[2].toLowerCase()); continue; }
    const mType = p.match(/^type:(image|text)$/i);
    if (mType) { out.type = mType[1].toLowerCase(); continue; }
    const mHas = p.match(/^has:(ocr|shortcut)$/i);
    if (mHas) { 
      if (mHas[1].toLowerCase() === 'ocr') out.hasOCR = true; 
      if (mHas[1].toLowerCase() === 'shortcut') out.hasShortcut = true; 
      continue; 
    }
    const mPin = p.match(/^pinned:(yes|no)$/i);
    if (mPin) { out.pinned = (mPin[1].toLowerCase() === 'yes'); continue; }
    const mShortcut = p.match(/^shortcut:(.+)$/i);
    if (mShortcut) { 
      // Search for specific shortcut keyword
      out.text.push(mShortcut[1]); 
      continue; 
    }
    out.text.push(p);
  }
  return out;
}
function itemPassesFilters(it, qobj) {
  if (qobj.type && it.type !== qobj.type) return false;
  if (qobj.pinned != null && !!it.pinned !== qobj.pinned) return false;
  if (qobj.hasOCR && !it.ocrText) return false;
  if (qobj.hasShortcut != null && !!it.shortcut !== qobj.hasShortcut) return false;
  const tags = uniq(it.tags || []);
  for (const t of qobj.include) if (!tags.includes(t)) return false;
  for (const t of qobj.exclude) if (tags.includes(t)) return false;
  return true;
}

/* ---------- Tag pills ---------- */
function tagPill(text, { removable = false, onRemove } = {}) {
  const pill = document.createElement('span');
  pill.className = 'tag';
  pill.textContent = text;
  pill.title = `Filter by tag:${text}`;
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = searchEl.value.trim();
    searchEl.value = (cur ? cur + ' ' : '') + `tag:${text}`;
    applyFilter();
  });
  if (removable) {
    const x = document.createElement('button');
    x.className = 'tag-x';
    x.textContent = '×';
    x.title = 'Remove tag';
    x.addEventListener('click', (e) => { e.stopPropagation(); onRemove?.(); });
    pill.appendChild(x);
  }
  return pill;
}
async function addTagsForItem(it) {
  const input = await openTextPrompt({
    title: 'Add tags',
    description: 'Comma-separated tags',
    placeholder: 'work, idea, ref'
  });
  if (!input) return;
  const newTags = uniq((it.tags || []).concat(input.split(',').map(s => s.trim())));
  await window.api.updateHistoryItem(it.id, { tags: newTags });
  items = await window.api.getHistory();
  applyFilter();
}
async function removeTagForItem(it, tag) {
  const next = uniq((it.tags || []).filter(t => t !== tag));
  await window.api.updateHistoryItem(it.id, { tags: next });
  items = await window.api.getHistory();
  applyFilter();
}

/* ---------- SVG icons & icon buttons ---------- */
function svg(name, opts = {}) {
  const filled = !!opts.filled;
  switch (name) {
    case 'external': // open in browser
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18 13v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h6"/>
        <path d="M15 3h6v6"/><path d="M21 3L10 14"/>
      </svg>`;
    case 'trash':
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
      </svg>`;
    case 'folder':
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
      </svg>`;
    case 'pencil':
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 21l3-1 12-12-2-2L4 18l-1 3z"/><path d="M14 4l2 2"/>
      </svg>`;
    case 'star':
      return filled
        ? `<svg class="icon fill" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>`
        : `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 17.25 18.18 21 16.54 14 22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24 7.45 14 5.82 21 12 17.25z"/>
          </svg>`;
    case 'stack': // Paste Stack icon
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="12" height="12" rx="2"/>
        <path d="M9 1h10a2 2 0 0 1 2 2v10M1 9v10a2 2 0 0 0 2 2h10"/>
      </svg>`;
    case 'mail': // Quick Actions
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>
      </svg>`;
    case 'map': // Quick Actions
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22s7-4.35 7-10a7 7 0 1 0-14 0c0 5.65 7 10 7 10z"/><circle cx="12" cy="11" r="3"/>
      </svg>`;
    case 'copy': // Quick Actions
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="9" width="12" height="12" rx="2"/><rect x="3" y="3" width="12" height="12" rx="2"/>
      </svg>`;
    case 'keyboard': // Text Shortcuts
      return `<svg class="icon stroke" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="6" width="20" height="12" rx="2"/>
        <line x1="6" y1="10" x2="6" y2="10"/>
        <line x1="10" y1="10" x2="10" y2="10"/>
        <line x1="14" y1="10" x2="14" y2="10"/>
        <line x1="18" y1="10" x2="18" y2="10"/>
        <line x1="6" y1="14" x2="18" y2="14"/>
      </svg>`;
    default: return '';
  }
}
// Uniform icon button; optional data-id for convenience
function iconBtn(cls, iconName, title, active=false, dataId=null){
  const idAttr = dataId != null ? ` data-id="${String(dataId)}"` : '';
  return `<button class="icon-btn ${cls} ${active?'is-active':''}"${idAttr}
                 title="${escapeHTML(title)}" aria-label="${escapeHTML(title)}">
            ${svg(iconName, { filled: active })}
          </button>`;
}

/* ---------- QUICK ACTIONS helpers ---------- */
function extractEmail(text='') {
  const m = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}
function extractCoords(text='') {
  const m = String(text).match(/\b-?\d{1,2}\.\d+,\s*-?\d{1,3}\.\d+\b/);
  return m ? m[0] : null;
}
function looksLikeAddress(text='') {
  const t = String(text);
  if (extractCoords(t)) return t;
  const streetRe = /\b\d{1,6}\s+[A-Za-z0-9.\- ]+\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|pl|place|way|pkwy|parkway|hwy|highway)\b/i;
  return streetRe.test(t) ? t : null;
}
function cleanPlainText(s='') {
  return String(s)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function buildQuickActionsHTML(it) {
  if (it.type !== 'text') return '';
  const t = String(it.text || '').trim();
  const btns = [];
  // URL action already exists via open-btn
  const email = extractEmail(t);
  if (email) btns.push(
    `<button class="icon-btn qa-email" data-id="${it.id}" title="Compose email">${svg('mail')}</button>`
  );
  const addr = looksLikeAddress(t);
  if (addr && !isUrlItem(it)) btns.push(
    `<button class="icon-btn qa-map" data-id="${it.id}" title="Open in Maps">${svg('map')}</button>`
  );
  if (t && !isUrlItem(it)) btns.push(
    `<button class="icon-btn qa-clean" data-id="${it.id}" title="Copy clean">${svg('copy')}</button>`
  );
  return btns.join('');
}

/* ---------- Simple in-overlay text prompt (used by Collections & Tags) ---------- */
async function openShortcutPrompt(item) {
  const existingShortcut = item.shortcut || '';
  
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:9999;
      display:flex; align-items:center; justify-content:center;`;
    const card = document.createElement('div');
    card.style.cssText = `
      width: min(480px, 92vw); background: var(--panel, #1f2937); color: var(--fg, #e5e7eb);
      border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.35); padding:16px;`;
    
    const previewText = item.type === 'text' 
      ? trimOneLine(item.text || '') 
      : `Image ${item.wh ? `(${item.wh.w}×${item.wh.h})` : ''}`;
    
    card.innerHTML = `
      <div style="font-weight:600; font-size:16px; margin-bottom:6px;">
        ${existingShortcut ? 'Edit Text Shortcut' : 'Create Text Shortcut'}
      </div>
      <div style="opacity:.8; font-size:12px; margin-bottom:10px; line-height:1.4;">
        ${escapeHTML(previewText)}
      </div>
      <div style="opacity:.7; font-size:11px; margin-bottom:12px;">
        Type <strong>${escapeHTML(cfg.shortcutTriggerPrefix || '//')}${escapeHTML(existingShortcut || 'shortcut')}</strong>, select it, and press Smart Paste hotkey to expand instantly.
      </div>
      <input id="__shortcut_input" type="text" placeholder="e.g. email_temp_1, signature, addr"
             value="${escapeHTML(existingShortcut)}"
             style="width:100%; padding:10px 12px; font-size:14px; border-radius:8px;
                    border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.06); color:inherit;
                    font-family: monospace;" />
      <div id="__shortcut_preview" style="margin-top:8px; font-size:11px; opacity:.6;">
        Preview: Type "${escapeHTML(cfg.shortcutTriggerPrefix || '//')}${escapeHTML(existingShortcut || 'your_shortcut')}", select + press Smart Paste hotkey → Expands
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
        ${existingShortcut ? '<button id="__shortcut_remove" style="padding:8px 12px; border-radius:8px; border:1px solid #ef4444; background:transparent; color:#ef4444;">Remove</button>' : ''}
        <button id="__shortcut_cancel" style="padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:transparent; color:inherit;">Cancel</button>
        <button id="__shortcut_save" style="padding:8px 12px; border-radius:8px; border:0; background:#3b82f6; color:white; font-weight:600;">Save</button>
      </div>`;
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const input = card.querySelector('#__shortcut_input');
    const btnSave = card.querySelector('#__shortcut_save');
    const btnCancel = card.querySelector('#__shortcut_cancel');
    const btnRemove = card.querySelector('#__shortcut_remove');

    const updatePreview = () => {
      const preview = card.querySelector('#__shortcut_preview');
      const val = input.value.trim();
      if (preview) {
        const prefix = cfg.shortcutTriggerPrefix || '//';
        preview.innerHTML = val 
          ? `Preview: Type "${escapeHTML(prefix)}${escapeHTML(val)}", select + press Smart Paste hotkey → Expands`
          : `Preview: Type "${escapeHTML(prefix)}your_shortcut", select + press Smart Paste hotkey → Expands`;
      }
    };

    input.addEventListener('input', updatePreview);

    const done = (result) => { 
      try { document.body.removeChild(backdrop); } catch {} 
      resolve(result); 
    };
    
    btnSave.addEventListener('click', async () => {
      const keyword = input.value.trim();
      if (!keyword) {
        input.focus();
        return;
      }
      
      // Validate keyword format
      if (!/^[a-zA-Z0-9_-]+$/.test(keyword)) {
        alert('Shortcut keyword can only contain letters, numbers, underscores, and hyphens.');
        input.focus();
        return;
      }
      
      // Check for duplicate shortcuts (excluding current item)
      const existingItem = items.find(i => i.shortcut === keyword && i.id !== item.id);
      if (existingItem) {
        const confirm = window.confirm(`Shortcut "${keyword}" is already used by another item. Replace it?`);
        if (!confirm) {
          input.focus();
          return;
        }
      }
      
      done({ action: 'save', keyword });
    });
    
    btnCancel.addEventListener('click', () => done({ action: 'cancel' }));
    btnRemove?.addEventListener('click', () => done({ action: 'remove' }));
    
    backdrop.addEventListener('click', (e) => { 
      if (e.target === backdrop) done({ action: 'cancel' }); 
    });
    
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); btnSave.click(); }
      if (e.key === 'Escape') { e.preventDefault(); btnCancel.click(); }
    });
    
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

function openTextPrompt({ title = 'Input', description = '', placeholder = '', value = '', okText = 'Save', cancelText = 'Cancel' } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:9999;
      display:flex; align-items:center; justify-content:center;`;
    const card = document.createElement('div');
    card.style.cssText = `
      width: min(520px, 92vw); background: var(--panel, #1f2937); color: var(--fg, #e5e7eb);
      border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.35); padding:16px;`;
    card.innerHTML = `
      <div style="font-weight:600; font-size:16px; margin-bottom:6px;">${escapeHTML(title)}</div>
      ${description ? `<div style="opacity:.8; font-size:12px; margin-bottom:10px; white-space:pre-line;">${escapeHTML(description)}</div>` : ''}
      <input id="__mini_prompt_input" type="text" placeholder="${escapeHTML(placeholder)}"
             value="${escapeHTML(value)}"
             style="width:100%; padding:10px 12px; font-size:14px; border-radius:8px;
                    border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.06); color:inherit;" />
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
        <button id="__mini_prompt_cancel" style="padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:transparent; color:inherit;">${escapeHTML(cancelText)}</button>
        <button id="__mini_prompt_ok" style="padding:8px 12px; border-radius:8px; border:0; background:#3b82f6; color:white; font-weight:600;">${escapeHTML(okText)}</button>
      </div>`;
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const input = card.querySelector('#__mini_prompt_input');
    const btnOK = card.querySelector('#__mini_prompt_ok');
    const btnCancel = card.querySelector('#__mini_prompt_cancel');

    const done = (val) => { try { document.body.removeChild(backdrop); } catch {} ; resolve(val); };
    btnOK.addEventListener('click', () => done(input.value.trim() || ''));
    btnCancel.addEventListener('click', () => done(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); btnOK.click(); }
      if (e.key === 'Escape') { e.preventDefault(); btnCancel.click(); }
    });
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  });
}

/* Tab overflow UX no longer needed with sidebar design */

/* ---------- Virtual Scrolling Configuration ---------- */
const VIRTUAL_CONFIG = {
  enabled: false, // Disabled for now to preserve grid layout
  itemHeight: 120, // Approximate height of each item in pixels
  bufferSize: 5,   // Extra items to render above/below viewport
  containerHeight: 400, // Approximate container height
  threshold: 200   // Only enable with very large datasets
};

let virtualState = {
  scrollTop: 0,
  startIndex: 0,
  endIndex: 0,
  totalHeight: 0
};

/* ---------- Optimized Virtual Rendering ---------- */
function render(list = []) {
  const renderStart = performance.now();
  
  // Use virtualization for large datasets
  if (VIRTUAL_CONFIG.enabled && list.length > VIRTUAL_CONFIG.threshold) {
    renderVirtualized(list);
  } else {
    renderDirect(list);
  }
  
  setSelected(Math.min(selectedIndex, Math.max(0, list.length - 1)));
  setupHeaderEditing();
  
  const renderTime = performance.now() - renderStart;
  if (renderTime > 10) { // Log slow renders
    console.log(`[render:perf] ${Math.round(renderTime)}ms for ${list.length} items`);
  }
}

function renderDirect(list) {
  resultsEl.innerHTML = '';
  
  // Reset any virtual scrolling styles that might interfere with CSS Grid
  resultsEl.style.height = '';
  resultsEl.style.position = '';
  
  const qobj = parseQuery((searchEl?.value || '').trim());
  const textNeedle = qobj.text.join(' ');

  list.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'row' + (it.type === 'image' ? ' image' : '');
    li.dataset.id = it.id;

    if (it.type === 'image') {
      const dims = it.wh ? ` (${it.wh.w}×${it.wh.h})` : '';
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      const ocrFull = (it.ocrText || '').trim();
      const ocrPreview = ocrFull ? ocrFull.slice(0, 120) : '';
      const pos = textNeedle && ocrPreview ? fuzzyMatch(ocrPreview, textNeedle).pos : new Set();
      const ocrHTML = ocrPreview
        ? `<div class="ocr-preview">${renderWithHighlights(ocrPreview, pos)}${ocrFull.length>120?'…':''}</div>`
        : '';

      const metaHTML = `
        ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
        ${iconBtn('pin-btn', 'star', it.pinned ? 'Unpin' : 'Pin', it.pinned, it.id)}
        ${iconBtn('shortcut-btn', 'keyboard', it.shortcut ? 'Edit text shortcut' : 'Create text shortcut', !!it.shortcut, it.id)}
        ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
        ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
        ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
      `;

      li.innerHTML = `
        <div class="card-header">
          <h3 class="card-title" contenteditable="true" data-id="${it.id}">${escapeHTML(it.header || 'Untitled')}</h3>
          <div class="header-icons">
            ${it.source || it.wh ? `<button class="info-btn" data-id="${it.id}" title="Show details">ℹ️</button>` : ''}
            <button class="edit-header-btn" data-id="${it.id}" title="Edit header">✏️</button>
          </div>
        </div>
        <div class="card-content image-content">
          <div class="thumbwrap">
            <img class="thumb" src="${it.thumb}" alt="Clipboard image" />
          </div>
        </div>
        <div class="tags" style="display: none;"></div>
        <div class="card-actions">
          <div class="card-actions-left">
            ${iconBtn('pin-btn', 'star', it.pinned ? 'Unpin' : 'Pin', it.pinned, it.id)}
            ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
          </div>
          <div class="card-actions-right">
            ${iconBtn('shortcut-btn', 'keyboard', it.shortcut ? 'Edit text shortcut' : 'Create text shortcut', !!it.shortcut, it.id)}
            ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
            ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
          </div>
        </div>
      `;
    } else {
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      const rawPrimary = trimOneLine(it.text || '');
      const pos = textNeedle ? fuzzyMatch(rawPrimary, textNeedle).pos : new Set();
      const primaryHTML = renderWithHighlights(rawPrimary, pos);

      // Quick Actions (email/map/clean)
      const qaHTML = buildQuickActionsHTML(it);

      const metaHTML = `
        ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
        ${iconBtn('pin-btn', 'star', it.pinned ? 'Unpin' : 'Pin', it.pinned, it.id)}
        ${isUrlItem(it) ? iconBtn('open-btn', 'external', 'Open in browser', false, it.id) : ''}
        ${qaHTML}
        ${iconBtn('shortcut-btn', 'keyboard', it.shortcut ? 'Edit text shortcut' : 'Create text shortcut', !!it.shortcut, it.id)}
        ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
        ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
        ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
      `;

      li.innerHTML = `
        <div class="card-header">
          <h3 class="card-title" contenteditable="true" data-id="${it.id}">${escapeHTML(it.header || 'Untitled')}</h3>
          <div class="header-icons">
            ${it.source ? `<button class="info-btn" data-id="${it.id}" title="Show details">ℹ️</button>` : ''}
            <button class="edit-header-btn" data-id="${it.id}" title="Edit header">✏️</button>
          </div>
        </div>
        <div class="card-content text-content">
          <div class="primary">${primaryHTML}</div>
          ${rawPrimary.length > 100 ? `<button class="expand-btn" data-id="${it.id}" title="View full text">...</button>` : ''}
        </div>
        <div class="tags" style="display: none;"></div>
        <div class="card-actions">
          <div class="card-actions-left">
            ${iconBtn('pin-btn', 'star', it.pinned ? 'Unpin' : 'Pin', it.pinned, it.id)}
            ${isUrlItem(it) ? iconBtn('open-btn', 'external', 'Open in browser', false, it.id) : ''}
            ${qaHTML}
            ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
          </div>
          <div class="card-actions-right">
            ${iconBtn('shortcut-btn', 'keyboard', it.shortcut ? 'Edit text shortcut' : 'Create text shortcut', !!it.shortcut, it.id)}
            ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
            ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
          </div>
        </div>
      `;
    }

    // Tags UI
    const wrap = li.querySelector('.tags');
    const tagList = uniq(it.tags || []);
    if (wrap) {
      // Add shortcut badge first if exists
      if (it.shortcut) {
        const shortcutBadge = document.createElement('span');
        shortcutBadge.className = 'shortcut-badge';
        shortcutBadge.textContent = `⌨ ${it.shortcut}`;
        shortcutBadge.title = `Text shortcut: ${it.shortcut} (click to filter)`;
        shortcutBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = searchEl.value.trim();
          searchEl.value = (cur ? cur + ' ' : '') + `shortcut:${it.shortcut}`;
          applyFilter();
        });
        wrap.appendChild(shortcutBadge);
      }
      
      tagList.forEach(t => wrap.appendChild(tagPill(t, { removable: true, onRemove: () => removeTagForItem(it, t) })));
      const addBtn = document.createElement('button');
      addBtn.className = 'tag-add';
      addBtn.textContent = '+ Tag';
      addBtn.title = 'Add tag';
      addBtn.addEventListener('click', (e) => { e.stopPropagation(); addTagsForItem(it); });
      wrap.appendChild(addBtn);
    }

    resultsEl.appendChild(li);
  });
}

function renderVirtualized(list) {
  const container = resultsEl.parentElement; // Scroll container
  const qobj = parseQuery((searchEl?.value || '').trim());
  const textNeedle = qobj.text.join(' ');
  
  // Calculate visible range
  const scrollTop = container.scrollTop || 0;
  const containerHeight = container.clientHeight || VIRTUAL_CONFIG.containerHeight;
  const itemHeight = VIRTUAL_CONFIG.itemHeight;
  
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - VIRTUAL_CONFIG.bufferSize);
  const endIndex = Math.min(list.length - 1, Math.ceil((scrollTop + containerHeight) / itemHeight) + VIRTUAL_CONFIG.bufferSize);
  
  virtualState = {
    scrollTop,
    startIndex,
    endIndex,
    totalHeight: list.length * itemHeight
  };
  
  // Create virtual container
  resultsEl.innerHTML = '';
  resultsEl.style.height = `${virtualState.totalHeight}px`;
  resultsEl.style.position = 'relative';
  
  // Render only visible items
  for (let i = startIndex; i <= endIndex; i++) {
    const it = list[i];
    if (!it) continue;
    
    const li = createListItem(it, qobj, textNeedle);
    li.style.position = 'absolute';
    li.style.top = `${i * itemHeight}px`;
    li.style.width = '100%';
    li.style.height = `${itemHeight}px`;
    li.dataset.virtualIndex = i;
    
    resultsEl.appendChild(li);
  }
  
  // Add scroll listener for virtual scrolling
  if (!container.hasVirtualScrollListener) {
    container.addEventListener('scroll', () => {
      if (VIRTUAL_CONFIG.enabled && filtered.length > VIRTUAL_CONFIG.threshold) {
        requestAnimationFrame(() => renderVirtualized(filtered));
      }
    });
    container.hasVirtualScrollListener = true;
  }
}

function createListItem(it, qobj, textNeedle) {
  const li = document.createElement('li');
  li.className = 'row' + (it.type === 'image' ? ' image' : '');
  li.dataset.id = it.id;
  
  // Ensure no positioning styles interfere with CSS Grid
  li.style.position = '';
  li.style.top = '';
  li.style.width = '';
  li.style.height = '';

  if (it.type === 'image') {
    const dims = it.wh ? ` (${it.wh.w}×${it.wh.h})` : '';
    const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
    const ocrFull = (it.ocrText || '').trim();
    const ocrPreview = ocrFull ? ocrFull.slice(0, 120) : '';
    const pos = textNeedle && ocrPreview ? fuzzyMatch(ocrPreview, textNeedle).pos : new Set();
    const ocrHTML = ocrPreview
      ? `<div class="ocr-preview">${renderWithHighlights(ocrPreview, pos)}${ocrFull.length>120?'…':''}</div>`
      : '';

    li.innerHTML = `
      <div class="card-header">
        <h3 class="card-title" contenteditable="true" data-id="${it.id}">${escapeHTML(it.header || 'Untitled')}</h3>
        <div class="header-icons">
          ${it.source || it.wh ? `<button class="info-btn" data-id="${it.id}" title="Show details">ℹ️</button>` : ''}
          <button class="edit-header-btn" data-id="${it.id}" title="Edit header">✏️</button>
        </div>
      </div>
      <div class="card-content image-content">
        <div class="thumbwrap">
          <img class="thumb" src="${it.thumb}" alt="Clipboard image" />
        </div>
      </div>
      <div class="tags" style="display: none;"></div>
      <div class="card-actions">
        <div class="card-actions-left">
          ${iconBtn('pin-btn', 'star', it.pinned ? 'Unpin' : 'Pin', it.pinned, it.id)}
          ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
        </div>
        <div class="card-actions-right">
          ${iconBtn('shortcut-btn', 'keyboard', it.shortcut ? 'Edit text shortcut' : 'Create text shortcut', !!it.shortcut, it.id)}
          ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
          ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
        </div>
      </div>
    `;
  } else {
    const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
    const rawPrimary = trimOneLine(it.text || '');
    const pos = textNeedle ? fuzzyMatch(rawPrimary, textNeedle).pos : new Set();
    const primaryHTML = renderWithHighlights(rawPrimary, pos);
    const qaHTML = buildQuickActionsHTML(it);

    li.innerHTML = `
      <div class="card-header">
        <h3 class="card-title" contenteditable="true" data-id="${it.id}">${escapeHTML(it.header || 'Untitled')}</h3>
        <div class="header-icons">
          ${it.source ? `<button class="info-btn" data-id="${it.id}" title="Show details">ℹ️</button>` : ''}
          <button class="edit-header-btn" data-id="${it.id}" title="Edit header">✏️</button>
        </div>
      </div>
      <div class="card-content text-content">
        <div class="primary">${primaryHTML}</div>
        ${rawPrimary.length > 100 ? `<button class="expand-btn" data-id="${it.id}" title="View full text">...</button>` : ''}
      </div>
      <div class="tags" style="display: none;"></div>
      <div class="card-actions">
        <div class="card-actions-left">
          ${iconBtn('pin-btn', 'star', it.pinned ? 'Unpin' : 'Pin', it.pinned, it.id)}
          ${isUrlItem(it) ? iconBtn('open-btn', 'external', 'Open in browser', false, it.id) : ''}
          ${qaHTML}
          ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
        </div>
        <div class="card-actions-right">
          ${iconBtn('shortcut-btn', 'keyboard', it.shortcut ? 'Edit text shortcut' : 'Create text shortcut', !!it.shortcut, it.id)}
          ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
          ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
        </div>
      </div>
    `;
  }

  // Tags UI
  const wrap = li.querySelector('.tags');
  const tagList = uniq(it.tags || []);
  if (wrap) {
    // Add shortcut badge first if exists
    if (it.shortcut) {
      const shortcutBadge = document.createElement('span');
      shortcutBadge.className = 'shortcut-badge';
      shortcutBadge.textContent = `⌨ ${it.shortcut}`;
      shortcutBadge.title = `Text shortcut: ${it.shortcut} (click to filter)`;
      shortcutBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = searchEl.value.trim();
        searchEl.value = (cur ? cur + ' ' : '') + `shortcut:${it.shortcut}`;
        applyFilter();
      });
      wrap.appendChild(shortcutBadge);
    }
    
    tagList.forEach(t => wrap.appendChild(tagPill(t, { removable: true, onRemove: () => removeTagForItem(it, t) })));
    const addBtn = document.createElement('button');
    addBtn.className = 'tag-add';
    addBtn.textContent = '+ Tag';
    addBtn.title = 'Add tag';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); addTagsForItem(it); });
    wrap.appendChild(addBtn);
  }

  return li;
}

function setupHeaderEditing() {
  const cardTitles = resultsEl.querySelectorAll('.card-title');
  cardTitles.forEach(titleEl => {
    titleEl.addEventListener('blur', async () => {
      const id = Number(titleEl.dataset.id);
      const newHeader = titleEl.textContent.trim() || 'Untitled';
      
      // Update local data
      const item = items.find(i => i.id === id);
      if (item && item.header !== newHeader) {
        item.header = newHeader;
        try {
          await window.api.updateHistoryItem(id, { header: newHeader });
        } catch (err) {
          console.error('[header] update error', err);
        }
      }
    });
    
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleEl.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Restore original text
        const id = Number(titleEl.dataset.id);
        const item = items.find(i => i.id === id);
        if (item) {
          titleEl.textContent = item.header || 'Untitled';
        }
        titleEl.blur();
      }
    });
  });
}

/* ---------- Expanded Text Popup ---------- */
function showExpandedTextPopup(item) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999;
      display: flex; align-items: center; justify-content: center; padding: 20px;`;

    const popup = document.createElement('div');
    popup.style.cssText = `
      width: min(800px, 90vw); max-height: 80vh; background: var(--secondary);
      border-radius: var(--border-radius); box-shadow: var(--shadow); padding: 24px;
      display: flex; flex-direction: column; gap: 16px; position: relative;`;

    popup.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin: 0; color: var(--text);">${escapeHTML(item.header || 'Untitled')}</h3>
        <button id="close-popup" style="background: none; border: none; font-size: 18px; cursor: pointer; color: var(--text-dim);">×</button>
      </div>
      <div style="font-size: 12px; color: var(--text-dim);">
        ${new Date(item.ts || Date.now()).toLocaleString()}${item.source ? ` • ${item.source.app ?? ''}` : ''}
      </div>
      <div style="flex: 1; overflow-y: auto; background: var(--primary); padding: 16px; border-radius: 8px; border: 1px solid var(--border);">
        <div style="font-size: 14px; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-break: break-word;">
          ${escapeHTML(item.text || '')}
        </div>
      </div>
    `;

    backdrop.appendChild(popup);
    document.body.appendChild(backdrop);

    const closeBtn = popup.querySelector('#close-popup');
    const close = () => {
      try { document.body.removeChild(backdrop); } catch {}
      resolve();
    };

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    document.addEventListener('keydown', function escListener(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escListener);
        close();
      }
    });
  });
}

/* ---------- Info Popup ---------- */
function showInfoPopup(item) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'info-popup';
    backdrop.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999;
      display: flex; align-items: center; justify-content: center; padding: 20px;`;

    const popup = document.createElement('div');
    popup.style.cssText = `
      width: min(600px, 90vw); background: var(--secondary);
      border-radius: var(--border-radius); box-shadow: var(--shadow); padding: 24px;
      position: relative;`;

    const sourceInfo = item.source ?
      `<div><strong>📱 Source App:</strong> ${escapeHTML(item.source.app || 'Unknown')}</div>
       ${item.source.title ? `<div><strong>🪟 Window Title:</strong> ${escapeHTML(item.source.title)}</div>` : ''}` : '';

    const sizeInfo = item.wh ?
      `<div><strong>📏 Image Size:</strong> ${item.wh.w} × ${item.wh.h} pixels</div>` : '';

    // Tags section with interactive tags
    const tagsInfo = item.tags && item.tags.length > 0 ?
      `<div><strong>🏷️ Tags:</strong> <div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">
        ${item.tags.map(tag => `<span style="display: inline-flex; align-items: center; gap: 2px; padding: 2px 8px; border-radius: 999px; background: var(--accent); color: white; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.015em;">${escapeHTML(tag)}</span>`).join('')}
      </div></div>` : '<div><strong>🏷️ Tags:</strong> None</div>';

    // OCR text section for images
    const ocrInfo = item.type === 'image' && item.ocrText ?
      `<div><strong>📄 OCR Text:</strong> <div style="background: var(--primary); padding: 12px; border-radius: 8px; margin-top: 4px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 120px; overflow-y: auto;">${escapeHTML(item.ocrText)}</div></div>` : '';

    // Text shortcut information
    const shortcutInfo = item.shortcut ?
      `<div><strong>⌨️ Text Shortcut:</strong> <code style="background: var(--success); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">${escapeHTML(item.shortcut)}</code></div>` : '';

    // Full content preview for text items
    const contentPreview = item.type !== 'image' && item.text ?
      `<div><strong>📄 Full Content:</strong> <div style="background: var(--primary); padding: 12px; border-radius: 8px; margin-top: 4px; font-size: 12px; line-height: 1.4; max-height: 200px; overflow-y: auto; white-space: pre-wrap;">${escapeHTML(item.text)}</div></div>` : '';

    popup.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; color: var(--text);">${escapeHTML(item.header || 'Untitled')}</h3>
        <button id="close-info-popup" style="background: none; border: none; font-size: 18px; cursor: pointer; color: var(--text-dim);">×</button>
      </div>
      <div style="color: var(--text); line-height: 1.6; gap: 12px; display: flex; flex-direction: column; max-height: 70vh; overflow-y: auto;">
        <div><strong>📅 Created:</strong> ${new Date(item.ts || Date.now()).toLocaleString()}</div>
        <div><strong>📄 Type:</strong> ${item.type === 'image' ? 'Image' : 'Text'}</div>
        ${sizeInfo}
        ${sourceInfo}
        ${tagsInfo}
        ${ocrInfo}
        ${shortcutInfo}
        ${contentPreview}
        ${item.filePath ? `<div><strong>📁 File Path:</strong> <code style="background: var(--primary); padding: 2px 4px; border-radius: 4px; font-size: 12px;">${escapeHTML(item.filePath)}</code></div>` : ''}
        <div style="margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--border-subtle); display: flex; gap: 8px; justify-content: flex-end;">
          <button id="edit-clip-btn" data-item-id="${item.id}" style="padding: 6px 12px; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">✏️ Edit</button>
          <button id="delete-clip-btn" data-item-id="${item.id}" style="padding: 6px 12px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">🗑️ Delete</button>
        </div>
      </div>
    `;

    backdrop.appendChild(popup);
    document.body.appendChild(backdrop);

    const closeBtn = popup.querySelector('#close-info-popup');
    const editBtn = popup.querySelector('#edit-clip-btn');
    const deleteBtn = popup.querySelector('#delete-clip-btn');

    const close = () => {
      try { document.body.removeChild(backdrop); } catch {}
      resolve();
    };

    // Close button with event propagation prevention
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      close();
    });

    // Edit button with event propagation prevention
    editBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const itemId = e.target.dataset.itemId;
      close();
      await editClipItem(itemId);
    });

    // Delete button with event propagation prevention
    deleteBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const itemId = e.target.dataset.itemId;
      close();
      await deleteClipItem(itemId);
    });

    // Backdrop click to close (only if clicking the backdrop itself)
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        e.stopPropagation();
        close();
      }
    });

    document.addEventListener('keydown', function escListener(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escListener);
        close();
      }
    });
  });
}

/* ---------- Sidebar Tabs (with collections) ---------- */
function rebuildTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = `
    <button class="sidebar-tab" data-tab="recent">
      <span class="tab-label">Recent</span>
    </button>
    <button class="sidebar-tab" data-tab="images">
      <span class="tab-label">Images</span>
    </button>
    <button class="sidebar-tab" data-tab="urls">
      <span class="tab-label">URLs</span>
    </button>
    <button class="sidebar-tab" data-tab="pinned">
      <span class="tab-label">Pinned</span>
    </button>
    <button class="sidebar-tab" data-tab="collections">
      <span class="tab-label">Collections</span>
    </button>
  `;
  // append user collections as dynamic tabs
  (collections || []).forEach(c => {
    const b = document.createElement('button');
    b.className = 'sidebar-tab';
    b.dataset.tab = `col:${c.id}`;
    b.innerHTML = `
      <span class="tab-icon">📂</span>
      <span class="tab-label">${escapeHTML(c.name)}</span>
    `;
    b.title = c.name;
    tabsEl.appendChild(b);
  });
  Array.from(tabsEl.querySelectorAll('.sidebar-tab')).forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.tab || 'recent') === currentTab);
  });
}

/* ---------- Optimized Filter + Search ---------- */
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 150;

function applyFilter(immediate = false) {
  // Debounce search to avoid excessive filtering
  if (!immediate && searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  
  const executeFilter = () => {
    const searchStart = performance.now();
    
    // Collections hub view
    if (currentTab === 'collections') {
      rebuildTabs();
      renderCollectionsHub();
      return;
    }

    const q = (searchEl?.value || '').trim();
    const qobj = parseQuery(q);

    let scope = items.slice();

    // Pre-filter by tab type (fast operations first)
    if (currentTab === 'images') {
      scope = scope.filter(i => i.type === 'image');
    } else if (currentTab === 'urls') {
      scope = scope.filter(i => i.type !== 'image' && isUrlItem(i));
    } else if (currentTab === 'pinned') {
      scope = scope.filter(i => !!i.pinned);
    } else if (currentTab.startsWith('col:')) {
      // Collection tab: data-tab="col:<id>"
      const colId = currentTab.slice(4);
      const col = (collections || []).find(c => c.id === colId);
      const colSet = new Set(col?.itemIds || []);
      scope = scope.filter(i => colSet.has(i.id));
    }

    // Advanced filters (type/has/pinned/tag)
    scope = scope.filter(it => itemPassesFilters(it, qobj));

    // Text search with performance optimization
    if (qobj.text.length) {
      const mode = (searchModeEl?.value || cfg.searchMode || 'fuzzy');
      const needle = qobj.text.join(' ');
      
      if (mode === 'fuzzy') {
        const thresh = Number(fuzzyThreshEl?.value || cfg.fuzzyThreshold || 0.4);
        const matches = [];
        
        // Process items in batches to avoid blocking UI
        for (const it of scope) {
          const searchText = baseSearchTextForItem(it);
          const result = fuzzyMatch(searchText, needle);
          if (result.score >= thresh) {
            matches.push({ ...it, _score: result.score });
          }
        }
        
        sortByScoreThenDefault(matches);
        filtered = matches;
      } else {
        // Exact search (faster)
        const needleLower = needle.toLowerCase();
        filtered = scope.filter(it => {
          const searchText = String(baseSearchTextForItem(it)).toLowerCase();
          return searchText.includes(needleLower);
        });
        sortCombined(filtered);
      }
    } else {
      filtered = scope;
      sortCombined(filtered);
    }

    selectedIndex = 0;
    rebuildTabs();
    render(filtered);
    
    // Update search performance stats
    const searchTime = performance.now() - searchStart;
    updateSearchStats(searchTime);
  };
  
  if (immediate) {
    executeFilter();
  } else {
    if (searchDebounceTimer) {
      clearManagedTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = createManagedTimeout(executeFilter, SEARCH_DEBOUNCE_MS);
  }
}

/* ---------- Selection & actions ---------- */
function setSelected(i) {
  selectedIndex = Math.max(0, Math.min((filtered.length - 1), i));
  Array.from(resultsEl.children).forEach((el, idx) => {
    el.classList.toggle('selected', idx === selectedIndex);
    if (idx === selectedIndex) el.scrollIntoView({ block: 'nearest' });
  });
}
function chooseByRow(row) {
  const id = Number(row.dataset.id);
  const it = filtered.find(i => i.id === id);
  if (!it) return;
  console.log('[choose] id=', id, 'type=', it.type);
  if (it.type === 'image') {
    window.api.setClipboard({ imagePath: it.filePath, imageDataUrl: it.thumb });
  } else {
    window.api.setClipboard({ text: it.text });
  }
  // Main decides to paste & hide depending on setting
}

/* ---------- Keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.api.hideOverlay(); e.preventDefault(); return; }
  if (e.key === 'ArrowDown') { setSelected(selectedIndex + 1); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { setSelected(selectedIndex - 1); e.preventDefault(); }
  else if (e.key === 'Enter') {
    const row = resultsEl.children[selectedIndex];
    if (row) chooseByRow(row);
  }

  // STACK: Ctrl/Cmd + Shift + Enter = paste ALL (place BEFORE plain Ctrl+Enter)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
    pasteAllFromStack();
    e.preventDefault();
    return;
  }
  // STACK: Ctrl/Cmd + Enter = paste NEXT (no Shift)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'Enter') {
    pasteNextFromStack();
    e.preventDefault();
    return;
  }
  // STACK: Ctrl+D toggle selected
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
    const row = resultsEl.children[selectedIndex];
    if (row) {
      const id = Number(row.dataset.id);
      const it = items.find(i => i.id === id);
      if (it) toggleStack(it);
    }
    e.preventDefault();
    return;
  }
  // STACK: Ctrl+Shift+X clear
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key.toLowerCase() === 'x')) {
    clearStack(true);
    e.preventDefault();
    return;
  }
});

/* Memory management for event listeners */
const eventListeners = new WeakMap();
const activeTimers = new Set();

function addManagedEventListener(element, event, handler, options = {}) {
  if (!element) return;
  
  const wrappedHandler = (...args) => {
    try {
      return handler(...args);
    } catch (error) {
      console.error('[event:error]', { event, error: error.message });
    }
  };
  
  element.addEventListener(event, wrappedHandler, options);
  
  if (!eventListeners.has(element)) {
    eventListeners.set(element, []);
  }
  eventListeners.get(element).push({ event, handler: wrappedHandler, options });
}

function removeManagedEventListener(element) {
  if (!element || !eventListeners.has(element)) return;
  
  const listeners = eventListeners.get(element);
  listeners.forEach(({ event, handler, options }) => {
    element.removeEventListener(event, handler, options);
  });
  eventListeners.delete(element);
}

function createManagedTimeout(callback, delay) {
  const timeoutId = setTimeout(() => {
    activeTimers.delete(timeoutId);
    callback();
  }, delay);
  activeTimers.add(timeoutId);
  return timeoutId;
}

function clearManagedTimeout(timeoutId) {
  if (timeoutId && activeTimers.has(timeoutId)) {
    clearTimeout(timeoutId);
    activeTimers.delete(timeoutId);
  }
}

// Cleanup all managed resources
function cleanupManagedResources() {
  // Clear all timers
  activeTimers.forEach(timerId => {
    try {
      clearTimeout(timerId);
    } catch (e) {
      // Ignore errors during cleanup
    }
  });
  activeTimers.clear();
  
  // Clear search cache periodically to prevent memory growth
  if (fuzzyMatchCache.size > MAX_CACHE_SIZE * 0.5) {
    fuzzyMatchCache.clear();
    cacheHits = 0;
    cacheMisses = 0;
  }
}

// Run cleanup periodically
setInterval(cleanupManagedResources, 60000); // Every minute

/* Search input with debouncing */
if (searchEl) {
  addManagedEventListener(searchEl, 'input', () => applyFilter());
}

/* Sidebar tabs click */
if (tabsEl) {
  addManagedEventListener(tabsEl, 'click', (e) => {
    const btn = e.target.closest('.sidebar-tab');
    if (!btn) return;
    currentTab = btn.dataset.tab || 'recent';
    localStorage.setItem('clip_tab', currentTab);
    rebuildTabs();
    applyFilter();
    if (!cfg.autoPasteOnSelect) { searchEl?.focus(); searchEl?.select(); }
  });
}

/* Row click delegation */
resultsEl?.addEventListener('click', async (e) => {
  // Helper to find row item id robustly (works even if buttons lack data-id)
  const getRowItemId = () => {
    const row = e.target.closest('li.row');
    return row ? Number(row.dataset.id) : NaN;
  };

  // Open URL
  const openBtn = e.target.closest('.open-btn');
  if (openBtn) {
    e.preventDefault(); e.stopPropagation();
    try {
      const id = Number(openBtn.dataset.id) || getRowItemId();
      const current = items.find(i => i.id === id);
      const url = current ? extractUrlFromText(current.text) : null;
      if (url) window.api.openUrl(url);
    } catch (err) { console.error('[open-url] error', err); }
    return;
  }

  // Pin
  const pinBtn = e.target.closest('.pin-btn');
  if (pinBtn) {
    e.preventDefault(); e.stopPropagation();
    try {
      const id = Number(pinBtn.dataset.id) || getRowItemId();
      const current = items.find(i => i.id === id);
      if (!current) return;
      await window.api.updateHistoryItem(id, { pinned: !current.pinned });
      items = await window.api.getHistory();
      applyFilter();
    } catch (err) { console.error('[pin] error', err); }
    return;
  }

  // QUICK ACTIONS: Compose Email
  const qaEmail = e.target.closest('.qa-email');
  if (qaEmail) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(qaEmail.dataset.id) || getRowItemId();
    const it = items.find(i => i.id === id);
    const email = extractEmail(it?.text || '');
    if (email) window.api.openUrl(`mailto:${encodeURIComponent(email)}`);
    return;
  }

  // QUICK ACTIONS: Open in Maps
  const qaMap = e.target.closest('.qa-map');
  if (qaMap) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(qaMap.dataset.id) || getRowItemId();
    const it = items.find(i => i.id === id);
    const t = String(it?.text || '');
    const q = extractCoords(t) || looksLikeAddress(t) || t.trim();
    if (q) window.api.openUrl(`https://www.google.com/maps/search/?q=${encodeURIComponent(q)}`);
    return;
  }

  // QUICK ACTIONS: Copy Clean (then main may auto-paste if enabled)
  const qaClean = e.target.closest('.qa-clean');
  if (qaClean) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(qaClean.dataset.id) || getRowItemId();
    const it = items.find(i => i.id === id);
    const cleaned = cleanPlainText(it?.text || '');
    if (cleaned) window.api.setClipboard({ text: cleaned });
    return;
  }

  // STACK: toggle per item
  const stackBtn = e.target.closest('.stack-btn');
  if (stackBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(stackBtn.dataset.id) || getRowItemId();
    const it = items.find(i => i.id === id);
    if (!it) return;
    toggleStack(it);
    // Reflect active state on the button without full re-render
    stackBtn.classList.toggle('is-active', inPasteStack(it.id));
    stackBtn.title = inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack';
    return;
  }

  // Delete
  const delBtn = e.target.closest('.del-btn');
  if (delBtn) {
    e.preventDefault(); e.stopPropagation();
    try {
      const id = Number(delBtn.dataset.id) || getRowItemId();
      await window.api.deleteHistoryItem(id);
      items = await window.api.getHistory();
      applyFilter();
    } catch (err) { console.error('[delete] error', err); }
    return;
  }

  // Edit header button
  const editHeaderBtn = e.target.closest('.edit-header-btn');
  if (editHeaderBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(editHeaderBtn.dataset.id);
    const titleEl = editHeaderBtn.parentElement.querySelector('.card-title');
    if (titleEl) {
      titleEl.focus();
      titleEl.select();
    }
    return;
  }

  // Expand text button
  const expandBtn = e.target.closest('.expand-btn');
  if (expandBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(expandBtn.dataset.id);
    const item = items.find(i => i.id === id);
    if (item) {
      showExpandedTextPopup(item);
    }
    return;
  }

  // Info button
  const infoBtn = e.target.closest('.info-btn');
  if (infoBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(infoBtn.dataset.id);
    const item = items.find(i => i.id === id);
    if (item) {
      showInfoPopup(item);
    }
    return;
  }

  // Shortcut button
  const shortcutBtn = e.target.closest('.shortcut-btn');
  if (shortcutBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(shortcutBtn.dataset.id) || getRowItemId();
    const it = items.find(i => i.id === id);
    if (!it) return;
    
    try {
      const result = await openShortcutPrompt(it);
      if (result.action === 'save') {
        // Clear existing shortcut from any other items first
        const existingItem = items.find(i => i.shortcut === result.keyword && i.id !== it.id);
        if (existingItem) {
          await window.api.updateHistoryItem(existingItem.id, { shortcut: null });
        }
        
        // Set new shortcut
        await window.api.updateHistoryItem(it.id, { shortcut: result.keyword });
        items = await window.api.getHistory();
        applyFilter();
      } else if (result.action === 'remove') {
        await window.api.updateHistoryItem(it.id, { shortcut: null });
        items = await window.api.getHistory();
        applyFilter();
      }
    } catch (err) {
      console.error('[shortcut] error', err);
    }
    return;
  }

  // Collections button
  const colBtn = e.target.closest('.col-btn');
  if (colBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(colBtn.dataset.id) || getRowItemId();
    const it = items.find(i => i.id === id);
    if (!it) return;
    await openCollectionsPromptForItem(it);
    return;
  }

  // Row choose (paste/select)
  const row = e.target.closest('li.row');
  if (row) chooseByRow(row);
});

/* Click outside closes */
document.addEventListener('mousedown', (e) => {
  // Don't minimize if clicking inside any popup/modal
  if (e.target.closest('.info-popup, .modal, .popup')) {
    return; // Exit early, don't minimize
  }

  // Don't minimize if clicking inside main overlay
  if (e.target.closest('.overlay')) {
    return; // Exit early, don't minimize
  }

  // Only minimize if truly clicking outside everything
  window.api.hideOverlay();
});

/* ---------- Collections: hub & prompt ---------- */
function renderCollectionsHub() {
  resultsEl.innerHTML = '';

  // Create new collection row
  const newRow = document.createElement('li');
  newRow.className = 'row';
  newRow.innerHTML = `
    <div class="primary"><strong>➕ New collection</strong></div>
    <div class="meta"><span>Create a new collection</span></div>`;
  newRow.addEventListener('click', async () => {
    try {
      const name = await openTextPrompt({
        title: 'New collection',
        placeholder: 'e.g. Research',
        okText: 'Create'
      });
      if (!name) return;
      if (!window.api?.collections?.create) {
        alert('Collections API not available (preload missing?)');
        return;
      }
      const created = await window.api.collections.create(name);
      collections = await window.api.collections.list();
      rebuildTabs();
      if (created?.id) {
        currentTab = `col:${created.id}`;
        localStorage.setItem('clip_tab', currentTab);
      }
      applyFilter();
    } catch (err) {
      console.error('[collections] create error', err);
      alert('Failed to create collection: ' + (err?.message || err));
    }
  });
  resultsEl.appendChild(newRow);

  // Existing collections
  (collections || []).forEach(c => {
    const count = (c.itemIds || []).length;
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.colId = c.id;
    li.innerHTML = `
      <div class="primary">📂 ${escapeHTML(c.name)}</div>
      <div class="meta">
        <span>${count} item${count===1?'':'s'}</span>
        <button class="icon-btn col-rename" data-id="${c.id}" title="Rename" aria-label="Rename">
          ${svg('pencil')}
        </button>
        <button class="icon-btn col-delete" data-id="${c.id}" title="Delete" aria-label="Delete">
          ${svg('trash')}
        </button>
      </div>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.col-rename') || e.target.closest('.col-delete')) return;
      currentTab = `col:${c.id}`;
      localStorage.setItem('clip_tab', currentTab);
      rebuildTabs();
      applyFilter();
    });

    li.querySelector('.col-rename')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const newName = await openTextPrompt({
          title: 'Rename collection',
          value: c.name,
          okText: 'Rename'
        });
        if (!newName || newName === c.name) return;
        await window.api.collections.rename(c.id, newName);
        collections = await window.api.collections.list();
        rebuildTabs();
        renderCollectionsHub();
      } catch (err) {
        console.error('[collections] rename error', err);
        alert('Rename failed: ' + (err?.message || err));
      }
    });

    li.querySelector('.col-delete')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const confirmName = await openTextPrompt({
          title: `Delete "${c.name}"?`,
          description: 'Type DELETE to confirm (items remain in history).',
          placeholder: 'DELETE',
          okText: 'Delete'
        });
        if (confirmName !== 'DELETE') return;
        await window.api.collections.remove(c.id);
        collections = await window.api.collections.list();
        rebuildTabs();
        renderCollectionsHub();
      } catch (err) {
        console.error('[collections] delete error', err);
        alert('Delete failed: ' + (err?.message || err));
      }
    });

    resultsEl.appendChild(li);
  });

  selectedIndex = 0;
}

async function openCollectionsPromptForItem(it) {
  const existing = (collections || [])
    .filter(c => (c.itemIds || []).includes(it.id))
    .map(c => c.name);

  const val = await openTextPrompt({
    title: 'Collections for this item',
    description:
      'Enter comma-separated names to ADD. Prefix a name with "-" to REMOVE.\n' +
      'Example: Work, Ideas, -Drafts',
    placeholder: 'Work, Ideas, -Drafts',
    value: existing.join(', '),
    okText: 'Apply'
  });
  if (val == null) return;

  const tokens = val.split(',').map(s => s.trim()).filter(Boolean);
  const toAddNames = [];
  const toRemoveNames = [];
  for (const t of tokens) {
    if (t.startsWith('-')) toRemoveNames.push(t.slice(1).trim());
    else toAddNames.push(t);
  }

  // Ensure add targets exist
  const nameToId = new Map((collections || []).map(c => [c.name, c.id]));
  for (const name of toAddNames) {
    if (!nameToId.has(name)) {
      const created = await window.api.collections.create(name);
      nameToId.set(created.name, created.id);
    }
  }

  // Apply changes
  for (const name of toAddNames) {
    const id = nameToId.get(name);
    if (id) await window.api.collections.addItems(id, [it.id]);
  }
  for (const name of toRemoveNames) {
    const id = nameToId.get(name);
    if (id) await window.api.collections.removeItems(id, [it.id]);
  }

  // Refresh
  collections = await window.api.collections.list();
  rebuildTabs();
  applyFilter();
}

/* ---------- STACK helpers & actions ---------- */
function inPasteStack(id){ return pasteStackIds.has(id); }
function updateStackChip(){
  const n = pasteStack.length;
  if (stackCountEl) stackCountEl.textContent = String(n);
  if (stackChipEl) {
    if (n > 0) stackChipEl.removeAttribute('hidden');
    else stackChipEl.setAttribute('hidden', 'true');
  }
  // Optional: persist for session
  try { sessionStorage.setItem('pasteStack', JSON.stringify(pasteStack)); } catch {}
}
function addToStack(it){
  if (!it) return;
  if (!pasteStackIds.has(it.id)) {
    pasteStack.push(it.id);
    pasteStackIds.add(it.id);
    console.log('[stack] add', it.id);
    updateStackChip();
  }
}
function removeFromStack(id){
  if (!pasteStackIds.has(id)) return;
  pasteStack = pasteStack.filter(x => x !== id);
  pasteStackIds.delete(id);
  console.log('[stack] remove', id);
  updateStackChip();
}
function toggleStack(it){
  if (inPasteStack(it.id)) removeFromStack(it.id);
  else addToStack(it);
}
// Paste NEXT (forces paste via main hook)
async function pasteNextFromStack(){
  if (pasteStack.length === 0) { console.log('[stack] empty'); return; }
  const id = pasteStack[0];
  const it = items.find(i => i.id === id);
  if (!it) { removeFromStack(id); return; }

  const payload = it.type === 'image'
    ? (it.filePath ? { imagePath: it.filePath } : { imageDataUrl: it.thumb })
    : { text: it.text };

  console.log('[stack] pasteNext (renderer) -> hide overlay then paste', { id, type: it.type });
  try { await window.api.hideOverlay(); } catch {}
  // let the OS refocus the target window
  await new Promise(r => setTimeout(r, 140));

  const ok = await window.api.stack.pasteNext(payload);
  console.log('[stack] pasteNext returned', ok);
  removeFromStack(id);
}

// Clear
function clearStack(confirm = false){
  if (confirm && !window.confirm('Clear Paste Stack?')) return;
  pasteStack = [];
  pasteStackIds.clear();
  console.log('[stack] cleared');
  updateStackChip();
}
// --- Paste ALL support ---
let pasteAllRunning = false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pasteAllFromStack(delayMs = 180) {
  if (pasteAllRunning) { console.log('[stack] pasteAll already running'); return; }
  pasteAllRunning = true;
  const delay = Math.max(0, Number(delayMs) || 180);
  console.log('[stack] pasteAll start, items =', pasteStack.length, 'delay =', delay);

  try {
    // Hide once, paste many
    try { await window.api.hideOverlay(); } catch {}
    await new Promise(r => setTimeout(r, 140));

    while (pasteStack.length > 0) {
      const id = pasteStack[0];
      const it = items.find(i => i.id === id);
      if (!it) { removeFromStack(id); continue; }

      const payload = it.type === 'image'
        ? (it.filePath ? { imagePath: it.filePath } : { imageDataUrl: it.thumb })
        : { text: it.text };

      console.log('[stack] pasteAll: next', { id, type: it.type });
      const ok = await window.api.stack.pasteNext(payload);
      console.log('[stack] pasteAll: pasted', ok);
      removeFromStack(id);

      if (pasteStack.length > 0 && delay > 0)
        await new Promise(r => setTimeout(r, delay));
    }
  } finally {
    pasteAllRunning = false;
    console.log('[stack] pasteAll done');
  }
}


/* ---------- Hotkey capture (unchanged) ---------- */
function keyToElectronKey(e) {
  if (/^[a-zA-Z]$/.test(e.key)) return e.key.toUpperCase();
  if (/^[0-9]$/.test(e.key)) return e.key;
  if (/^F[1-9][0-9]?$/.test(e.key)) return e.key;
  const map = {
    ' ': 'Space', 'Spacebar': 'Space',
    'Escape': 'Escape', 'Esc': 'Escape',
    'Enter': 'Enter', 'Return': 'Enter',
    'Tab': 'Tab','Backspace': 'Backspace','Delete': 'Delete','Insert': 'Insert',
    'Home': 'Home','End': 'End','PageUp': 'PageUp','PageDown': 'PageDown',
    'ArrowUp': 'Up','ArrowDown': 'Down','ArrowLeft': 'Left','ArrowRight': 'Right',
    '`': '`','-':'-','=':'=','[':'[',']':']','\\':'\\',';':';',"'":"'",',':',','.':'.','/':'/'
  };
  return map[e.key] || null;
}
function eventToAccelerator(e) {
  if (e.key === 'Tab') return null;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    if (e.key !== 'Escape') return null;
  }
  const parts = [];
  if (e.ctrlKey && e.metaKey) { parts.push('Super','Ctrl'); }
  else if (e.ctrlKey) parts.push('Ctrl'); else if (e.metaKey) parts.push('Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = keyToElectronKey(e);
  if (!key) return null;
  const modNames = ['Control','Ctrl','Alt','Shift','Super','Meta','Command','CommandOrControl','CmdOrCtrl'];
  if (modNames.includes(key)) return null;
  parts.push(key);
  return parts.join('+');
}
function displayLabel(accel) {
  return accel.replace(/CommandOrControl/gi,'Ctrl/⌘').replace(/\bSuper\b/gi,'Win/⌘');
}
hotkeyEl?.setAttribute('placeholder','Click, then press shortcut (e.g. Ctrl+Shift+Space)');
hotkeyEl?.addEventListener('focus', () => hotkeyEl.select());
hotkeyEl?.addEventListener('keydown', (e) => {
  const accel = eventToAccelerator(e);
  if (accel) {
    e.preventDefault();
    hotkeyEl.dataset.accelValue = accel;
    hotkeyEl.value = displayLabel(accel);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    delete hotkeyEl.dataset.accelValue;
    hotkeyEl.value = '';
  }
});

// Smart Paste hotkey capture
smartPasteHotkeyEl?.setAttribute('placeholder','Click, then press hotkey (e.g. F12)');
smartPasteHotkeyEl?.addEventListener('focus', () => smartPasteHotkeyEl.select());
smartPasteHotkeyEl?.addEventListener('keydown', (e) => {
  const accel = eventToAccelerator(e);
  if (accel) {
    e.preventDefault();
    smartPasteHotkeyEl.dataset.accelValue = accel;
    smartPasteHotkeyEl.value = displayLabel(accel);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    delete smartPasteHotkeyEl.dataset.accelValue;
    smartPasteHotkeyEl.value = '';
  }
});

/* ---------- Theme ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}
themeEl?.addEventListener('change', () => applyTheme(themeEl.value));

/* ---------- Optimized Boot Process ---------- */
async function boot() {
  const bootStart = performance.now();
  console.log('[boot] Starting renderer initialization');
  
  // Phase 1: Essential UI state (synchronous)
  try {
    // Apply cached theme immediately to avoid flash
    const cachedTheme = localStorage.getItem('clip_theme') || 'dark';
    applyTheme(cachedTheme);
    
    // Restore stack from session (fast synchronous operation)
    try {
      const saved = JSON.parse(sessionStorage.getItem('pasteStack') || '[]');
      pasteStack = saved.filter((x) => typeof x === 'number');
      pasteStackIds = new Set(pasteStack);
    } catch {}
    updateStackChip();
    
    console.log('[boot] Phase 1 complete:', Math.round(performance.now() - bootStart), 'ms');
  } catch (e) {
    console.error('[boot] Phase 1 error:', e);
  }

  // Phase 2: Load data in parallel (asynchronous)
  const dataPromises = [
    window.api.getHistory().catch(() => []),
    window.api.getSettings().catch(() => ({})),
    window.api.collections.list().catch(() => [])
  ];
  
  try {
    const [historyData, settingsData, collectionsData] = await Promise.all(dataPromises);
    
    // Update state
    items = historyData;
    collections = collectionsData;
    cfg = { ...cfg, ...settingsData };
    
    // Cache theme for next boot
    localStorage.setItem('clip_theme', cfg.theme);
    
    console.log('[boot] Data loaded:', {
      items: items.length,
      collections: collections.length,
      time: Math.round(performance.now() - bootStart) + 'ms'
    });
  } catch (e) {
    console.error('[boot] Data loading error:', e);
    // Use fallback empty state
    items = [];
    collections = [];
  }

  // Phase 3: Update UI elements (batched to avoid layout thrashing)
  try {
    const uiUpdates = () => {
      // Theme
      if (themeEl) themeEl.value = cfg.theme;
      applyTheme(cfg.theme);

      // Hotkey display
      if (hotkeyEl) {
        hotkeyEl.dataset.accelValue = cfg.hotkey;
        hotkeyEl.value = displayLabel(cfg.hotkey);
      }
      
      // Settings form elements
      if (maxItemsEl) maxItemsEl.value = cfg.maxItems;
      if (captureEl) captureEl.checked = !!cfg.captureContext;
      if (searchModeEl) searchModeEl.value = cfg.searchMode;
      if (fuzzyThreshEl) fuzzyThreshEl.value = String(cfg.fuzzyThreshold);
      if (autoPasteEl) autoPasteEl.checked = !!cfg.autoPasteOnSelect;
      
      // Text shortcuts settings
      if (enableTextShortcutsEl) enableTextShortcutsEl.checked = !!cfg.enableTextShortcuts;
      if (shortcutTriggerPrefixEl) shortcutTriggerPrefixEl.value = cfg.shortcutTriggerPrefix || '//';
      if (shortcutCaseSensitiveEl) shortcutCaseSensitiveEl.checked = !!cfg.shortcutCaseSensitive;
      if (shortcutMinLengthEl) shortcutMinLengthEl.value = String(cfg.shortcutMinLength || 2);
      if (showShortcutNotificationsEl) showShortcutNotificationsEl.checked = !!cfg.showShortcutNotifications;
      
      // Smart Paste settings
      if (enableSmartPasteEl) enableSmartPasteEl.checked = !!cfg.enableSmartPaste;
      if (smartPasteHotkeyEl) {
        smartPasteHotkeyEl.dataset.accelValue = cfg.smartPasteHotkey || 'F12';
        smartPasteHotkeyEl.value = displayLabel(cfg.smartPasteHotkey || 'F12');
      }
    };
    
    // Batch UI updates to avoid multiple reflows
    requestAnimationFrame(uiUpdates);
    
    console.log('[boot] UI updated:', Math.round(performance.now() - bootStart), 'ms');
  } catch (e) {
    console.error('[boot] UI update error:', e);
  }

  // Phase 4: Render initial view (can be deferred)
  requestAnimationFrame(() => {
    try {
      filtered = items.slice();
      rebuildTabs();
      render(filtered);
      setSelected(0);
      
      const totalTime = Math.round(performance.now() - bootStart);
      console.log('[boot] Complete:', totalTime, 'ms', {
        items: items.length,
        collections: collections.length,
        virtualEnabled: VIRTUAL_CONFIG.enabled && items.length > VIRTUAL_CONFIG.threshold
      });
    } catch (e) {
      console.error('[boot] Render error:', e);
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  await boot();

  // UI ready

  // STACK chip gestures:
  // - Click: paste NEXT
  // - Shift/Alt + Click: paste ALL
  // - Right-click: clear
// Chip: click = paste next; Shift/Alt-click = paste all; right-click = clear
stackChipEl?.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  if (e.shiftKey || e.altKey) pasteAllFromStack();
  else pasteNextFromStack();
});
stackChipEl?.addEventListener('contextmenu', (e) => {
  e.preventDefault(); e.stopPropagation();
  clearStack(true);
});


  // History live update
  window.api.onHistoryUpdate((list) => {
    items = list || [];
    // Prune stack of missing items
    const liveIds = new Set((items || []).map(i => i.id));
    pasteStack = pasteStack.filter(id => liveIds.has(id));
    pasteStackIds = new Set(pasteStack);
    updateStackChip();

    applyFilter();
  });

  // Collections live update
  window.api.collections.onUpdate((list) => {
    collections = list || [];
    rebuildTabs();
    if (currentTab.startsWith('col:')) {
      const colId = currentTab.slice(4);
      if (!collections.some(c => c.id === colId)) currentTab = 'collections';
    }
    applyFilter();
  });

  window.api.onOverlayShow(async () => {
    window.api.getHistory().then(h => {
      items = h || [];
      applyFilter();
    });
    rebuildTabs();
    applyTheme(themeEl?.value || cfg.theme);

    // Only focus the search if auto-paste is OFF (keep caret in target app)
    let s = {};
    try { s = await window.api.getSettings(); } catch {}
    const autoPaste = !!s?.autoPasteOnSelect;
    console.log('[overlay] onOverlayShow autoPasteOnSelect =', autoPaste);
    if (!autoPaste) {
      searchEl?.focus();
      searchEl?.select();
    }
  });

  window.api.onOverlayAnim((visible) => overlayCard?.classList.toggle('show', !!visible));
});

/* ---------- Performance monitoring functions ---------- */
async function updatePerformanceMonitor() {
  if (!perfMonitorEl) return;
  
  try {
    const stats = await window.api.perf.getStats();
    
    const formatBytes = (bytes) => {
      const mb = bytes / 1024 / 1024;
      return mb < 1 ? `${Math.round(mb * 1024)}KB` : `${Math.round(mb)}MB`;
    };
    
    const html = `
      <div><strong>Clipboard Polling</strong></div>
      <div>• Rate: ${stats.clipboard.pollsPerSecond}/sec (${stats.clipboard.adaptiveInterval}ms interval)</div>
      <div>• Avg poll time: ${stats.clipboard.avgPollTime}ms</div>
      <div>• Total polls: ${stats.clipboard.totalPolls}</div>
      
      <div style="margin-top: 8px;"><strong>OCR Processing</strong></div>
      <div>• Processed: ${stats.ocr.totalProcessed} (${stats.ocr.successRate}% success)</div>
      <div>• Avg time: ${stats.ocr.avgProcessingTime}ms</div>
      <div>• Queue: ${stats.ocr.queueSize} | Workers: ${stats.ocr.activeWorkers}/${stats.ocr.workerPoolSize}</div>
      <div>• Errors: ${stats.ocr.errors}</div>
      
      <div style="margin-top: 8px;"><strong>Memory Usage</strong></div>
      <div>• Heap: ${formatBytes(stats.memory.usage.heapUsed)} / ${formatBytes(stats.memory.usage.heapTotal)}</div>
      <div>• External: ${formatBytes(stats.memory.usage.external)}</div>
      
      <div style="margin-top: 8px;"><strong>Smart Headers</strong></div>
      <div>• Generated: ${stats.headers.totalGenerated} (${stats.headers.textHeaders} text, ${stats.headers.imageHeaders} image)</div>
      <div>• OCR updates: ${stats.headers.ocrUpdates}</div>
      <div>• Avg time: ${stats.headers.avgGenerationTime}ms</div>
      
      <div style="margin-top: 8px;"><strong>Search Performance</strong></div>
      <div>• Avg search: ${searchStats.avgSearchTime}ms</div>
      <div>• Cache: ${fuzzyMatchCache.size} entries (${Math.round((cacheHits / (cacheHits + cacheMisses)) * 100)}% hit rate)</div>
      
      <div style="margin-top: 8px;"><strong>App Info</strong></div>
      <div>• Uptime: ${Math.floor(stats.app.uptime / 60)}m ${stats.app.uptime % 60}s</div>
      <div>• Version: ${stats.app.version} (${stats.app.platform})</div>
      <div>• Items: ${items.length} | Collections: ${collections.length}</div>
    `;
    
    perfMonitorEl.innerHTML = html;
  } catch (error) {
    perfMonitorEl.innerHTML = `<div style="color: #ef4444;">Error loading stats: ${error.message}</div>`;
  }
}

/* ---------- Settings actions ---------- */
clearBtn?.addEventListener('click', async () => {
  await window.api.clearHistory();
  items = [];
  applyFilter();
});
settingsBtn?.addEventListener('click', () => {
  settingsEl?.classList.add('open');
  updatePerformanceMonitor(); // Load performance stats when opening settings
  settingsEl?.querySelector('input,select,button,textarea')?.focus();
});
closeBtn?.addEventListener('click', () => settingsEl?.classList.remove('open'));
refreshPerfBtn?.addEventListener('click', updatePerformanceMonitor);

// Request feature button
document.querySelector('.request-feature-link')?.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  try {
    await window.api.openUrl('https://snippetstash.featurebase.app/');
    console.log('[request-feature] Opened feature request URL');
  } catch (error) {
    console.error('[request-feature] Error opening URL:', error);
  }
});

saveBtn?.addEventListener('click', async () => {
  const payload = {
    theme: (themeEl?.value || cfg.theme),
    hotkey: (hotkeyEl?.dataset?.accelValue || hotkeyEl?.value || cfg.hotkey || 'CommandOrControl+Shift+Space'),
    maxItems: Number(maxItemsEl?.value || cfg.maxItems || 500),
    captureContext: !!(captureEl?.checked ?? cfg.captureContext),
    searchMode: (searchModeEl?.value || cfg.searchMode),
    fuzzyThreshold: Number(fuzzyThreshEl?.value || cfg.fuzzyThreshold || 0.4),
    autoPasteOnSelect: !!(autoPasteEl?.checked ?? cfg.autoPasteOnSelect),
    // overlaySize removed
    // Text shortcuts settings
    enableTextShortcuts: !!(enableTextShortcutsEl?.checked ?? cfg.enableTextShortcuts),
    shortcutTriggerPrefix: (shortcutTriggerPrefixEl?.value || cfg.shortcutTriggerPrefix || '//'),
    shortcutCaseSensitive: !!(shortcutCaseSensitiveEl?.checked ?? cfg.shortcutCaseSensitive),
    shortcutMinLength: Number(shortcutMinLengthEl?.value || cfg.shortcutMinLength || 2),
    showShortcutNotifications: !!(showShortcutNotificationsEl?.checked ?? cfg.showShortcutNotifications),
    
    // Smart Paste settings
    enableSmartPaste: !!(enableSmartPasteEl?.checked ?? cfg.enableSmartPaste),
    smartPasteHotkey: (smartPasteHotkeyEl?.dataset?.accelValue || smartPasteHotkeyEl?.value || cfg.smartPasteHotkey || 'F12'),
  };
  cfg = { ...cfg, ...payload };
  try {
    await window.api.saveSettings(payload);
    // resize removed - using single fixed size
  } catch {}
  settingsEl?.classList.remove('open');
  applyTheme(cfg.theme);
  applyFilter();
});

/* ---------- Settings flyout & Esc handling ---------- */
(function () {
  function closeSettings() { settingsEl && settingsEl.classList.remove('open'); }
  document.addEventListener('DOMContentLoaded', () => closeSettings());
  saveBtn && saveBtn.addEventListener('click', (e) => { e.stopPropagation(); closeSettings(); });
  closeBtn && closeBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsEl && settingsEl.classList.contains('open')) {
      e.preventDefault(); closeSettings();
    }
  });
})();

/* ---------- Edit and Delete Clip Item Functions ---------- */
async function editClipItem(itemId) {
  const item = state.clipboard.find(it => it.id === itemId);
  if (!item) return;

  const result = await showPromptDialog('Edit Item', 'text', item.text || '', 'Save', 'Cancel', 'Remove');
  if (result && result.action === 'save') {
    // Update the item text
    item.text = result.value;
    item.header = result.value.slice(0, 40);

    // Save to storage
    await window.api.updateClipboardItem(itemId, { text: result.value, header: item.header });

    // Re-render the current view
    applyFilter();
  } else if (result && result.action === 'remove') {
    await deleteClipItem(itemId);
  }
}

async function deleteClipItem(itemId) {
  const item = state.clipboard.find(it => it.id === itemId);
  if (!item) return;

  const confirmed = await showConfirmDialog(
    'Delete Item',
    `Are you sure you want to delete this item?\n\n"${(item.text || item.header || 'Untitled').slice(0, 100)}${(item.text || item.header || '').length > 100 ? '...' : ''}"`
  );

  if (confirmed) {
    // Remove from local state
    state.clipboard = state.clipboard.filter(it => it.id !== itemId);

    // Remove from storage
    await window.api.removeClipboardItem(itemId);

    // Re-render the current view
    applyFilter();
  }
}
