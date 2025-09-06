// renderer.js — ORIGINAL UI PRESERVED + Smart Tags & Filters
// Tabs, fuzzy/exact search, URL open, OCR preview, keyboard nav: unchanged

const $ = (sel) => document.querySelector(sel);

/* Core elements */
const overlayCard = $('.overlay');
const resultsEl   = $('#results');
const searchEl    = $('#search');
const settingsEl  = $('#settings');
const hotkeyEl    = $('#hotkey');
const maxItemsEl  = $('#maxItems');
const captureEl   = $('#captureContext');
const clearBtn    = $('#clearBtn');
const settingsBtn = $('#settingsBtn');
const saveBtn     = $('#saveSettings');
const closeBtn    = $('#closeSettings');

/* Search settings UI */
const searchModeEl   = $('#searchMode');
const fuzzyThreshEl  = $('#fuzzyThreshold');

/* Theme setting UI */
const themeEl = $('#theme');

/* Tabs */
const tabsEl = document.querySelector('.tabs');

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
};
let lastQuery = '';
let lastMode  = 'fuzzy';

/* ---------- Utils (original + helpers) ---------- */
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

/* ---------- Fuzzy matching (span density) ---------- */
function fuzzyMatch(hayRaw = '', qRaw = '') {
  const hay = String(hayRaw);
  const q   = String(qRaw);
  if (!q) return { score: 1, pos: new Set() };

  const hayL = hay.toLowerCase();
  const qL   = q.toLowerCase();
  const len  = hayL.length;
  const qlen = qL.length;

  const idx = hayL.indexOf(qL);
  if (idx >= 0) {
    const pos = new Set();
    for (let i = idx; i < idx + qlen && i < len; i++) pos.add(i);
    const startBonus = 1 - (idx / Math.max(1, len));
    const tightBonus = Math.min(1, qlen / Math.max(qlen, 12));
    const score = Math.min(1, 0.65 + 0.25*startBonus + 0.10*tightBonus);
    return { score, pos };
  }

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
  if (j < qlen) return { score: 0, pos: new Set() };

  const span = (last - first + 1);
  const density = qlen / span;
  const startBonus = 1 - (first / Math.max(1, len));
  const gapPenalty = (span - qlen) / span;
  const score = Math.max(0, Math.min(1, 0.6*density + 0.3*startBonus + 0.1*(1-gapPenalty)));
  return { score, pos };
}

/* Render helper for highlights */
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

/* ---------- Sorting & rendering (original) ---------- */
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
  if (it.type !== 'image') return String(it.text || '');
  const dims = it.wh ? `${it.wh.w}x${it.wh.h}` : '';
  const meta = `${dims} ${it?.source?.app || ''} ${it?.source?.title || ''}`;
  return (it.ocrText && it.ocrText.trim()) ? it.ocrText : meta;
}

/* ---------- NEW: Query parsing & filters ---------- */
function parseQuery(q) {
  const out = { text: [], include: [], exclude: [], type: null, hasOCR: null, pinned: null };
  const parts = String(q || '').trim().split(/\s+/).filter(Boolean);
  for (const p of parts) {
    const mTag = p.match(/^(-)?tag:(.+)$/i);
    if (mTag) { (mTag[1] ? out.exclude : out.include).push(mTag[2].toLowerCase()); continue; }
    const mType = p.match(/^type:(image|text)$/i);
    if (mType) { out.type = mType[1].toLowerCase(); continue; }
    const mHas = p.match(/^has:(ocr)$/i);
    if (mHas) { out.hasOCR = true; continue; }
    const mPin = p.match(/^pinned:(yes|no)$/i);
    if (mPin) { out.pinned = (mPin[1].toLowerCase() === 'yes'); continue; }
    out.text.push(p);
  }
  return out;
}
function itemPassesFilters(it, qobj) {
  if (qobj.type && it.type !== qobj.type) return false;
  if (qobj.pinned != null && !!it.pinned !== qobj.pinned) return false;
  if (qobj.hasOCR && !it.ocrText) return false;
  const tags = uniq(it.tags || []);
  for (const t of qobj.include) if (!tags.includes(t)) return false;
  for (const t of qobj.exclude) if (tags.includes(t)) return false;
  return true;
}

/* ---------- Rendering (add tag pills under primary) ---------- */
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
  const input = prompt('Add tag(s), comma-separated:', '');
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

function render(list = []) {
  resultsEl.innerHTML = '';
  const q = lastQuery;
  const qobj = parseQuery(q);
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

      li.innerHTML = `
        <div class="thumbwrap">
          <img class="thumb" src="${it.thumb}" alt="Clipboard image${dims}" />
        </div>
        <div class="cell">
          <div class="primary">Image${dims}</div>
          ${ocrHTML}
          <div class="tags"></div>
          <div class="meta">
            ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
            <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">${it.pinned ? '⭐' : '☆'}</button>
            <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
          </div>
        </div>
      `;
    } else {
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      const rawPrimary = trimOneLine(it.text || '');
      const pos = textNeedle ? fuzzyMatch(rawPrimary, textNeedle).pos : new Set();
      const primaryHTML = renderWithHighlights(rawPrimary, pos);

      const openBtnHTML = isUrlItem(it)
        ? `<button class="open-btn" data-id="${it.id}" title="Open in browser">↗</button>`
        : '';
      li.innerHTML = `
        <div class="primary">${primaryHTML}</div>
        <div class="tags"></div>
        <div class="meta">
          ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
          <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">${it.pinned ? '⭐' : '☆'}</button>
          ${openBtnHTML}
          <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
        </div>
      `;
    }

    // Render tag pills
    const wrap = li.querySelector('.tags');
    const tagList = uniq(it.tags || []);
    if (wrap) {
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

  setSelected(Math.min(selectedIndex, Math.max(0, list.length - 1)));
}

/* ---------- Tabs UI (unchanged) ---------- */
function updateTabsUI() {
  if (!tabsEl) return;
  Array.from(tabsEl.querySelectorAll('.tab')).forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.tab || 'recent') === currentTab);
  });
}

/* ---------- Filtering & search (extended) ---------- */
function applyFilter() {
  const q = (searchEl.value || '').trim();
  lastQuery = q;
  lastMode  = (searchModeEl?.value || cfg.searchMode || 'fuzzy');

  const qobj = parseQuery(q);

  let scope = items.slice();
  // Tabs first (original behavior)
  if (currentTab === 'images') scope = scope.filter(i => i.type === 'image');
  if (currentTab === 'urls')   scope = scope.filter(i => i.type !== 'image' && isUrlItem(i));
  if (currentTab === 'pinned') scope = scope.filter(i => !!i.pinned);

  // Then apply advanced filters (type/has:ocr/pinned/tag includes/excludes)
  scope = scope.filter(it => itemPassesFilters(it, qobj));

  // No text part? keep your default sort & render
  if (qobj.text.length === 0) {
    filtered = scope;
    sortCombined(filtered);
    selectedIndex = 0;
    updateTabsUI();
    return render(filtered);
  }

  // Text search part
  if (lastMode === 'fuzzy') {
    const thresh = Number(fuzzyThreshEl?.value || cfg.fuzzyThreshold || 0.4);
    const needle = qobj.text.join(' ');
    const matches = [];
    for (const it of scope) {
      const s = fuzzyMatch(baseSearchTextForItem(it), needle).score;
      if (s >= thresh) matches.push({ ...it, _score: s });
    }
    sortByScoreThenDefault(matches);
    filtered = matches;
  } else {
    const needle = qobj.text.join(' ').toLowerCase();
    filtered = scope.filter(it => String(baseSearchTextForItem(it)).toLowerCase().includes(needle));
    sortCombined(filtered);
  }

  selectedIndex = 0;
  updateTabsUI();
  render(filtered);
}

/* ---------- Selection & actions (unchanged) ---------- */
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
  if (it.type === 'image') {
    window.api.setClipboard({ imagePath: it.filePath, imageDataUrl: it.thumb });
  } else {
    window.api.setClipboard({ text: it.text });
  }
  window.api.hideOverlay();
}

/* ---------- Keyboard (unchanged) ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.api.hideOverlay(); e.preventDefault(); return; }
  if (e.key === 'ArrowDown') { setSelected(selectedIndex + 1); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { setSelected(selectedIndex - 1); e.preventDefault(); }
  else if (e.key === 'Enter') {
    const row = resultsEl.children[selectedIndex];
    if (row) chooseByRow(row);
  }
});

/* ---------- Search ---------- */
searchEl.addEventListener('input', () => applyFilter());

/* ---------- Tabs click (unchanged) ---------- */
if (tabsEl) {
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    currentTab = btn.dataset.tab || 'recent';
    localStorage.setItem('clip_tab', currentTab);
    updateTabsUI();
    applyFilter();
    searchEl.focus();
  });
}

/* ---------- Click delegation (unchanged actions) ---------- */
resultsEl.addEventListener('click', async (e) => {
  const openBtn = e.target.closest('.open-btn');
  if (openBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(openBtn.dataset.id);
    const current = items.find(i => i.id === id);
    const url = current ? extractUrlFromText(current.text) : null;
    if (url) window.api.openUrl(url);
    return;
  }

  const pinBtn = e.target.closest('.pin-btn');
  if (pinBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(pinBtn.dataset.id);
    const current = items.find(i => i.id === id);
    if (!current) return;
    await window.api.updateHistoryItem(id, { pinned: !current.pinned });
    items = await window.api.getHistory();
    applyFilter();
    return;
  }

  const delBtn = e.target.closest('.del-btn');
  if (delBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(delBtn.dataset.id);
    await window.api.deleteHistoryItem(id);
    items = await window.api.getHistory();
    applyFilter();
    return;
  }

  const row = e.target.closest('li.row');
  if (row) chooseByRow(row);
});

/* ---------- Click outside card closes (unchanged) ---------- */
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.overlay')) window.api.hideOverlay();
});

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

/* ---------- Theme (unchanged) ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}
themeEl?.addEventListener('change', () => applyTheme(themeEl.value));

/* ---------- Boot (unchanged except rendering supports tags) ---------- */
async function boot() {
  items = await window.api.getHistory().catch(() => []);
  try {
    const s = await window.api.getSettings();
    cfg.theme = s.theme || cfg.theme;
    cfg.hotkey = s.hotkey || cfg.hotkey;
    cfg.maxItems = s.maxItems ?? cfg.maxItems;
    cfg.captureContext = !!s.captureContext;
    cfg.searchMode = s.searchMode || cfg.searchMode;
    cfg.fuzzyThreshold = typeof s.fuzzyThreshold === 'number' ? s.fuzzyThreshold : cfg.fuzzyThreshold;

    if (themeEl) themeEl.value = cfg.theme;
    applyTheme(cfg.theme);

    if (hotkeyEl) {
      hotkeyEl.dataset.accelValue = cfg.hotkey;
      hotkeyEl.value = displayLabel(cfg.hotkey);
    }
    if (maxItemsEl) maxItemsEl.value = cfg.maxItems;
    if (captureEl) captureEl.checked = !!cfg.captureContext;
    if (searchModeEl)  searchModeEl.value  = cfg.searchMode;
    if (fuzzyThreshEl) fuzzyThreshEl.value = String(cfg.fuzzyThreshold);
  } catch {}

  filtered = items.slice();
  updateTabsUI();
  render(filtered);
  setSelected(0);
}

window.addEventListener('DOMContentLoaded', async () => {
  await boot();

  window.api.onHistoryUpdate((list) => {
    items = list || [];
    applyFilter();
  });

  window.api.onOverlayShow(() => {
    window.api.getHistory().then(h => { items = h || []; applyFilter(); });
    updateTabsUI();
    applyTheme(themeEl?.value || cfg.theme);
    searchEl.focus();
    searchEl.select();
  });

  window.api.onOverlayAnim((visible) => overlayCard?.classList.toggle('show', !!visible));
});

/* ---------- Settings (unchanged) ---------- */
clearBtn?.addEventListener('click', async () => {
  await window.api.clearHistory();
  items = [];
  applyFilter();
});
settingsBtn?.addEventListener('click', () => {
  settingsEl?.classList.add('open');
  settingsEl?.querySelector('input,select,button,textarea')?.focus();
});
closeBtn?.addEventListener('click', () => settingsEl?.classList.remove('open'));

saveBtn?.addEventListener('click', async () => {
  const pickedHotkey = hotkeyEl?.dataset.accelValue || cfg.hotkey;
  const payload = {
    theme: (themeEl?.value || cfg.theme),
    hotkey: pickedHotkey,
    maxItems: Number(maxItemsEl?.value || cfg.maxItems || 500),
    captureContext: !!(captureEl?.checked ?? cfg.captureContext),
    searchMode: (searchModeEl?.value || cfg.searchMode),
    fuzzyThreshold: Number(fuzzyThreshEl?.value || cfg.fuzzyThreshold || 0.4),
  };
  cfg = { ...cfg, ...payload };
  try { await window.api.saveSettings(payload); } catch {}
  settingsEl?.classList.remove('open');
  applyTheme(cfg.theme);
  applyFilter();
});


/* ---------- Settings flyout shim (safe, minimal) ---------- */
(function () {
  const settingsEl  = document.getElementById('settings');
  const settingsBtn = document.getElementById('settingsBtn');
  const saveBtn     = document.getElementById('saveSettings');
  const closeBtn    = document.getElementById('closeSettings');

  function openSettings()  { settingsEl && settingsEl.classList.add('open'); }
  function closeSettings() { settingsEl && settingsEl.classList.remove('open'); }
  function toggleSettings(){ settingsEl && settingsEl.classList.toggle('open'); }

  // Ensure panel is CLOSED on boot, even if HTML had 'open' by mistake
  document.addEventListener('DOMContentLoaded', () => {
    closeSettings();

    settingsBtn && settingsBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleSettings();
    });

    // Close on Save/Close; your existing saveSettings logic (if any) still runs
    saveBtn && saveBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      closeSettings();
    });

    closeBtn && closeBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      closeSettings();
    });
  });

  // Also allow Esc to close just the settings panel (without hiding overlay)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsEl && settingsEl.classList.contains('open')) {
      e.preventDefault();
      closeSettings();
    }
  });
})();


/* ---------- FIX: settings flyout + robust tab wiring ---------- */
(() => {
  const settingsEl  = document.getElementById('settings');
  const settingsBtn = document.getElementById('settingsBtn');
  const saveBtn     = document.getElementById('saveSettings');
  const closeBtn    = document.getElementById('closeSettings');
  const tabsEl      = document.querySelector('.tabs');

  function openSettings()  { settingsEl && settingsEl.classList.add('open'); }
  function closeSettings() { settingsEl && settingsEl.classList.remove('open'); }

  document.addEventListener('DOMContentLoaded', () => {
    // Make it a top-right flyout (keeps your bottom-sheet CSS as fallback)
    if (settingsEl) {
      settingsEl.classList.add('flyout');     // enables the flyout override CSS
      settingsEl.classList.remove('open');    // start closed
    }

    if (settingsBtn && !settingsBtn.dataset.wired) {
      settingsBtn.dataset.wired = '1';
      settingsBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        settingsEl.classList.toggle('open');
        if (settingsEl.classList.contains('open')) {
          // focus first control for immediate typing
          settingsEl.querySelector('input,select,button,textarea')?.focus();
        }
      });
    }

    if (saveBtn && !saveBtn.dataset.wired) {
      saveBtn.dataset.wired = '1';
      saveBtn.addEventListener('click', (e) => {
        // Your existing save handler still runs; this only guarantees close.
        e.stopPropagation();
        closeSettings();
      });
    }

    if (closeBtn && !closeBtn.dataset.wired) {
      closeBtn.dataset.wired = '1';
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        closeSettings();
      });
    }

    // Defensive re-bind of tabs (restores images/urls/pinned switching if lost)
    if (tabsEl && !tabsEl.dataset.wired) {
      tabsEl.dataset.wired = '1';
      tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        // Uses the existing globals/functions in your file:
        currentTab = btn.dataset.tab || 'recent';
        localStorage.setItem('clip_tab', currentTab);
        updateTabsUI();
        applyFilter();
        document.getElementById('search')?.focus();
      });
    }
  });

  // Let Esc close just the settings (without hiding overlay)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsEl && settingsEl.classList.contains('open')) {
      e.preventDefault();
      closeSettings();
    }
  });
})();
