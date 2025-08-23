// renderer.js

/* ---------- DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);

/* Core elements */
const overlayCard = $('.overlay');
const resultsEl   = $('#results');
const searchEl    = $('#search');
const settingsEl  = $('#settings');
const themeSelect = $('#themeSelect');         // Theme dropdown in Settings
const hotkeyEl    = $('#hotkey');
const maxItemsEl  = $('#maxItems');
const captureEl   = $('#captureContext');
const clearBtn    = $('#clearBtn');
const settingsBtn = $('#settingsBtn');
const saveBtn     = $('#saveSettings');
const closeBtn    = $('#closeSettings');

/* Tabs */
const tabsEl = document.querySelector('.tabs');

/* ---------- State ---------- */
let items = [];
let filtered = [];
let selectedIndex = 0;
let currentTab = localStorage.getItem('clip_tab') || 'recent';
let cfg = {
  theme: 'dark',                 // keep your existing dark look as default
  hotkey: '',
  maxItems: 500,
  captureContext: false,
  searchMode: 'fuzzy',
  fuzzyThreshold: 0.5,
};

/* ---------- Theme (light-only override) ---------- */
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  // Dark = default (no attribute); Light = set attribute to enable light-theme.css overrides only
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  if (themeSelect) themeSelect.value = t;
}

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
  url = url.replace(/[)\]\}>,.;!?]+$/g, ''); // trim trailing punctuation
  return url;
}
function isUrlItem(it) {
  return it.type === 'text' && URL_RE.test(String(it.text || ''));
}

/* ---------- Sorting & rendering ---------- */
function sortCombined(arr) {
  arr.sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    new Date(b.ts) - new Date(a.ts)
  );
}

function render(list = []) {
  resultsEl.innerHTML = '';
  list.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = it.id;

    if (it.type === 'image') {
      const dims = it.wh ? ` (${it.wh.w}×${it.wh.h})` : '';
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      const ocrPreview = (it.ocrText || '').trim();
      const ocrLine = ocrPreview
        ? `<div class="ocr-preview">${escapeHTML(ocrPreview.slice(0, 120))}${ocrPreview.length>120?'…':''}</div>`
        : '';
      li.innerHTML = `
        <div class="thumbwrap">
          <img class="thumb" src="${it.thumb}" alt="Clipboard image${dims}" />
        </div>
        <div class="cell">
          <div class="primary">Image${dims}</div>
          ${ocrLine}
          <div class="meta">
            ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
            <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">${it.pinned ? '⭐' : '☆'}</button>
            <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
          </div>
        </div>
      `;
    } else {
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      const primary = escapeHTML(trimOneLine(it.text || ''));
      const openBtnHTML = isUrlItem(it)
        ? `<button class="open-btn" data-id="${it.id}" title="Open in browser">↗</button>`
        : '';
      li.innerHTML = `
        <div class="primary">${primary}</div>
        <div class="meta">
          ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
          <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">${it.pinned ? '⭐' : '☆'}</button>
          ${openBtnHTML}
          <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
        </div>
      `;
    }

    resultsEl.appendChild(li);
  });

  setSelected(Math.min(selectedIndex, Math.max(0, list.length - 1)));
}

/* ---------- Tabs UI ---------- */
function updateTabsUI() {
  if (!tabsEl) return;
  Array.from(tabsEl.querySelectorAll('.tab')).forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.tab || 'recent') === currentTab);
  });
}

/* ---------- Filtering & search (includes OCR) ---------- */
function applyFilter() {
  const q = (searchEl.value || '').trim().toLowerCase();
  let scope = items.slice();

  if (currentTab === 'images') scope = scope.filter(i => i.type === 'image');
  if (currentTab === 'urls')   scope = scope.filter(i => i.type !== 'image' && isUrlItem(i));
  if (currentTab === 'pinned') scope = scope.filter(i => !!i.pinned);

  if (!q) {
    filtered = scope;
    sortCombined(filtered);
    selectedIndex = 0;
    updateTabsUI();
    return render(filtered);
  }

  const texts = scope.filter(i => i.type !== 'image');
  const imgs  = scope.filter(i => i.type === 'image');

  const textResults = texts.filter(it => String(it.text || '').toLowerCase().includes(q));
  const ocrHits = imgs.filter(it => (it.ocrText || '').toLowerCase().includes(q));
  const metaHits = imgs.filter(it => {
    if (it.ocrText) return false; // already matched
    const dims = it.wh ? `${it.wh.w}x${it.wh.h}` : '';
    const hay = `${dims} ${it?.source?.app || ''} ${it?.source?.title || ''}`.toLowerCase();
    return hay.includes(q);
  });

  filtered = [...textResults, ...ocrHits, ...metaHits];
  sortCombined(filtered);
  selectedIndex = 0;
  updateTabsUI();
  render(filtered);
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

  if (it.type === 'image') {
    window.api.setClipboard({ imagePath: it.filePath, imageDataUrl: it.thumb });
  } else {
    window.api.setClipboard({ text: it.text });
  }
  window.api.hideOverlay();
}

/* ---------- Keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.api.hideOverlay();
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    setSelected(selectedIndex + 1);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    setSelected(selectedIndex - 1);
    e.preventDefault();
  } else if (e.key === 'Enter') {
    const row = resultsEl.children[selectedIndex];
    if (row) chooseByRow(row);
  }
});

/* ---------- Search ---------- */
searchEl.addEventListener('input', () => applyFilter());

/* ---------- Tabs click ---------- */
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

/* ---------- Click delegation ---------- */
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

/* ---------- Click outside card closes ---------- */
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.overlay')) window.api.hideOverlay();
});

/* ---------- Boot ---------- */
async function boot() {
  items = await window.api.getHistory().catch(() => []);
  try {
    const s = await window.api.getSettings();
    cfg.theme = (s.theme === 'light') ? 'light' : 'dark';   // default to dark if unset
    cfg.hotkey = s.hotkey;
    cfg.maxItems = s.maxItems;
    cfg.captureContext = !!s.captureContext;
    cfg.searchMode = s.searchMode || 'fuzzy';
    cfg.fuzzyThreshold = typeof s.fuzzyThreshold === 'number' ? s.fuzzyThreshold : 0.5;

    if (themeSelect) themeSelect.value = cfg.theme;
    if (hotkeyEl) hotkeyEl.value = cfg.hotkey || '';
    if (maxItemsEl) maxItemsEl.value = cfg.maxItems || 500;
    if (captureEl) captureEl.checked = !!cfg.captureContext;
  } catch {}

  applyTheme(cfg.theme);
  filtered = items.slice();
  updateTabsUI();
  render(filtered);
  setSelected(0);
}

window.addEventListener('DOMContentLoaded', async () => {
  await boot();

  // Theme dropdown in Settings
  themeSelect?.addEventListener('change', async () => {
    cfg.theme = themeSelect.value === 'light' ? 'light' : 'dark';
    applyTheme(cfg.theme);
    try {
      await window.api.saveSettings({
        theme: cfg.theme,
        hotkey: cfg.hotkey,
        maxItems: cfg.maxItems,
        captureContext: cfg.captureContext,
        searchMode: cfg.searchMode,
        fuzzyThreshold: cfg.fuzzyThreshold,
      });
    } catch {}
  });

  window.api.onHistoryUpdate((list) => {
    items = list || [];
    applyFilter();
  });

  window.api.onOverlayShow(() => {
    window.api.getHistory().then(h => { items = h || []; applyFilter(); });
    updateTabsUI();
    searchEl.focus();
    searchEl.select();
  });

  window.api.onOverlayAnim((visible) => overlayCard?.classList.toggle('show', !!visible));
});

/* ---------- Settings ---------- */
clearBtn.onclick = async () => {
  await window.api.clearHistory();
  items = [];
  applyFilter();
};

settingsBtn.onclick = () => {
  settingsEl?.classList.add('open');
  settingsEl?.querySelector('input,select,button,textarea')?.focus();
};

closeBtn.onclick = () => settingsEl?.classList.remove('open');

saveBtn.onclick = async () => {
  const payload = {
    theme: (themeSelect?.value || cfg.theme),
    hotkey: hotkeyEl?.value || cfg.hotkey || '',
    maxItems: Number(maxItemsEl?.value || cfg.maxItems || 500),
    captureContext: !!(captureEl?.checked ?? cfg.captureContext),
    searchMode: cfg.searchMode,
    fuzzyThreshold: cfg.fuzzyThreshold,
  };
  cfg = { ...cfg, ...payload };
  try { await window.api.saveSettings(payload); } catch {}
  settingsEl?.classList.remove('open');
  applyTheme(cfg.theme);
};
