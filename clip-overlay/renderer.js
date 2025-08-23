// renderer.js

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

/* Tabs */
const tabsEl = document.querySelector('.tabs');

/* ---------- State ---------- */
let items = [];
let filtered = [];
let selectedIndex = 0;
let currentTab = localStorage.getItem('clip_tab') || 'recent';
let cfg = {
  hotkey: '',
  maxItems: 500,
  captureContext: false,
  searchMode: 'fuzzy',
  fuzzyThreshold: 0.4, // a bit looser default works better for subsequence queries
};
let lastQuery = '';
let lastMode  = 'fuzzy';

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

/* ---------- Fuzzy matching (better ranking) ----------
   - If substring: strong score biased to earlier starts.
   - Else subsequence: uses span density (qlen/span), start bonus, gap penalty.
   Returns { score: 0..1, pos: Set<int> } where pos are indices to highlight.
------------------------------------------------------ */
function fuzzyMatch(hayRaw = '', qRaw = '') {
  const hay = String(hayRaw);
  const q   = String(qRaw);
  if (!q) return { score: 1, pos: new Set() };

  const hayL = hay.toLowerCase();
  const qL   = q.toLowerCase();
  const len  = hayL.length;
  const qlen = qL.length;

  // Substring first (contiguous)
  const idx = hayL.indexOf(qL);
  if (idx >= 0) {
    const pos = new Set();
    for (let i = idx; i < idx + qlen && i < len; i++) pos.add(i);

    // Earlier & tighter substrings are better
    const startBonus = 1 - (idx / Math.max(1, len));           // 0..1 (earlier is better)
    const tightBonus = Math.min(1, qlen / Math.max(qlen, 12));  // short queries don't over-dominate
    const score = Math.min(1, 0.65 + 0.25*startBonus + 0.10*tightBonus);
    return { score, pos };
  }

  // Greedy subsequence
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
  if (j < qlen) return { score: 0, pos: new Set() }; // not all letters found in order

  const span = (last - first + 1);               // window covering the match
  const density = qlen / span;                   // 0..1 (1 = contiguous)
  const startBonus = 1 - (first / Math.max(1, len)); // earlier appears better
  const gapPenalty = (span - qlen) / span;       // 0..1 (0 best)

  // Blend: dense span matters most; earlier start helps; fewer gaps helps.
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

/* ---------- Sorting & rendering ---------- */
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

function render(list = []) {
  resultsEl.innerHTML = '';
  const q = lastQuery;
  const mode = lastMode;

  list.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = it.id;

    if (it.type === 'image') {
      const dims = it.wh ? ` (${it.wh.w}×${it.wh.h})` : '';
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';

      const ocrFull = (it.ocrText || '').trim();
      const ocrPreview = ocrFull ? ocrFull.slice(0, 120) : '';
      const pos = q && ocrPreview
        ? (mode === 'fuzzy' ? fuzzyMatch(ocrPreview, q).pos
                             : fuzzyMatch(ocrPreview, q).pos)
        : new Set();
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
      const pos = q ? fuzzyMatch(rawPrimary, q).pos : new Set();
      const primaryHTML = renderWithHighlights(rawPrimary, pos);

      const openBtnHTML = isUrlItem(it)
        ? `<button class="open-btn" data-id="${it.id}" title="Open in browser">↗</button>`
        : '';
      li.innerHTML = `
        <div class="primary">${primaryHTML}</div>
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

/* ---------- Filtering & search ---------- */
function applyFilter() {
  const q = (searchEl.value || '').trim();
  lastQuery = q;
  lastMode  = (searchModeEl?.value || cfg.searchMode || 'fuzzy');

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

  if (lastMode === 'fuzzy') {
    const thresh = Number(fuzzyThreshEl?.value || cfg.fuzzyThreshold || 0.4);
    const matches = [];
    for (const it of scope) {
      // score on the "search text" (full text or OCR/meta)
      const s = fuzzyMatch(baseSearchTextForItem(it), q).score;
      if (s >= thresh) matches.push({ ...it, _score: s });
    }
    sortByScoreThenDefault(matches);
    filtered = matches;
  } else {
    const qlc = q.toLowerCase();
    filtered = scope.filter(it => String(baseSearchTextForItem(it)).toLowerCase().includes(qlc));
    sortCombined(filtered);
  }

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
    cfg.hotkey = s.hotkey;
    cfg.maxItems = s.maxItems;
    cfg.captureContext = !!s.captureContext;
    cfg.searchMode = s.searchMode || 'fuzzy';
    cfg.fuzzyThreshold = typeof s.fuzzyThreshold === 'number' ? s.fuzzyThreshold : 0.4;

    if (hotkeyEl) hotkeyEl.value = cfg.hotkey || '';
    if (maxItemsEl) maxItemsEl.value = cfg.maxItems || 500;
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
    searchEl.focus();
    searchEl.select();
  });

  window.api.onOverlayAnim((visible) => overlayCard?.classList.toggle('show', !!visible));
});

/* ---------- Settings ---------- */
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
  const payload = {
    hotkey: hotkeyEl?.value || cfg.hotkey || '',
    maxItems: Number(maxItemsEl?.value || cfg.maxItems || 500),
    captureContext: !!(captureEl?.checked ?? cfg.captureContext),
    searchMode: (searchModeEl?.value || cfg.searchMode),
    fuzzyThreshold: Number(fuzzyThreshEl?.value || cfg.fuzzyThreshold || 0.4),
  };
  cfg = { ...cfg, ...payload };
  try { await window.api.saveSettings(payload); } catch {}
  settingsEl?.classList.remove('open');
  applyFilter();
});
