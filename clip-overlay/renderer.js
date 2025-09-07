// renderer.js — full file
// Preserves original features + adds: Paste-on-select toggle wiring,
// Overlay size save/apply, and Collections (hub + dynamic tabs).

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

const searchModeEl  = $('#searchMode');
const fuzzyThreshEl = $('#fuzzyThreshold');

const autoPasteEl   = $('#autoPasteOnSelect'); // paste on select toggle
const overlaySizeEl = $('#overlaySize');       // overlay size select

/* Tabs container */
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
  autoPasteOnSelect: true,
  overlaySize: 'large',
};
// NEW: collections state
let collections = [];

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

/* ---------- Fuzzy matching ---------- */
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
// Simple in-overlay text prompt (no external CSS)
// Usage: const v = await openTextPrompt({ title, description, placeholder, value, okText });
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
      ${description ? `<div style="opacity:.8; font-size:12px; margin-bottom:10px;">${escapeHTML(description)}</div>` : ''}
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

// Enable horizontal scroll for tabs (wheel to scroll, drag to pan)
// Idempotent horizontal scroll/drag for tabs
function enableTabsOverflowUX() {
  const el = document.querySelector('.tabs');
  if (!el || el.dataset.overflowWired === '1') return;
  el.dataset.overflowWired = '1';

  // Wheel vertically => scroll horizontally
  el.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Click-drag to pan
  let down = false, startX = 0, startLeft = 0;
  el.addEventListener('mousedown', (e) => {
    down = true; startX = e.pageX; startLeft = el.scrollLeft;
    el.classList.add('dragging');
  });
  window.addEventListener('mouseup', () => { down = false; el.classList.remove('dragging'); });
  window.addEventListener('mousemove', (e) => {
    if (!down) return;
    el.scrollLeft = startLeft - (e.pageX - startX);
  });
}




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

/* Smart query: tag/type/has/pinned + free text */
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

/* ---------- Rendering list ---------- */
function render(list = []) {
  resultsEl.innerHTML = '';
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
            <button class="col-btn" data-id="${it.id}" title="Add/remove in collections">📁</button> <!-- NEW -->
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
        ? `<button class="open-btn" data-id="${it.id}" title="Open in browser">↗</button>` : '';

      li.innerHTML = `
        <div class="primary">${primaryHTML}</div>
        <div class="tags"></div>
        <div class="meta">
          ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
          <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">${it.pinned ? '⭐' : '☆'}</button>
          ${openBtnHTML}
          <button class="col-btn" data-id="${it.id}" title="Add/remove in collections">📁</button> <!-- NEW -->
          <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
        </div>
      `;
    }

    // Tags UI
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

/* ---------- Tabs (with collections) ---------- */
function rebuildTabs() { // NEW: replaces updateTabsUI
  if (!tabsEl) return;
  tabsEl.innerHTML = `
    <button class="tab" data-tab="recent">recent</button>
    <button class="tab" data-tab="images">images</button>
    <button class="tab" data-tab="urls">urls</button>
    <button class="tab" data-tab="pinned">pinned</button>
    <button class="tab" data-tab="collections">collections</button>
  `;
  // append user collections as dynamic tabs
  (collections || []).forEach(c => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.dataset.tab = `col:${c.id}`;
    b.textContent = c.name;
    b.title = c.name;  
    tabsEl.appendChild(b);
  });
  Array.from(tabsEl.querySelectorAll('.tab')).forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.tab || 'recent') === currentTab);
  });

  enableTabsOverflowUX();
}

/* ---------- Filter + Search ---------- */
function applyFilter() {
  // Collections hub view
  if (currentTab === 'collections') {
    rebuildTabs();
    renderCollectionsHub(); // NEW
    return;
  }

  const q = (searchEl?.value || '').trim();
  const qobj = parseQuery(q);

  let scope = items.slice();

  // Default tabs
  if (currentTab === 'images') scope = scope.filter(i => i.type === 'image');
  if (currentTab === 'urls')   scope = scope.filter(i => i.type !== 'image' && isUrlItem(i));
  if (currentTab === 'pinned') scope = scope.filter(i => !!i.pinned);

  // Collection tab: data-tab="col:<id>"
  if (currentTab.startsWith('col:')) {
    const colId = currentTab.slice(4);
    const col = (collections || []).find(c => c.id === colId);
    const colSet = new Set(col?.itemIds || []);
    scope = scope.filter(i => colSet.has(i.id));
  }

  // Advanced filters (type/has/pinned/tag)
  scope = scope.filter(it => itemPassesFilters(it, qobj));

  // Text search
  if (qobj.text.length) {
    const mode = (searchModeEl?.value || cfg.searchMode || 'fuzzy');
    if (mode === 'fuzzy') {
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
  } else {
    filtered = scope;
    sortCombined(filtered);
  }

  selectedIndex = 0;
  rebuildTabs();
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
  console.log('[choose] id=', id, 'type=', it.type);
  if (it.type === 'image') {
    window.api.setClipboard({ imagePath: it.filePath, imageDataUrl: it.thumb });
  } else {
    window.api.setClipboard({ text: it.text });
  }
  // Main decides to paste & hide depending on setting
}

/* Keyboard */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.api.hideOverlay(); e.preventDefault(); return; }
  if (e.key === 'ArrowDown') { setSelected(selectedIndex + 1); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { setSelected(selectedIndex - 1); e.preventDefault(); }
  else if (e.key === 'Enter') {
    const row = resultsEl.children[selectedIndex];
    if (row) chooseByRow(row);
  }
});

/* Search input */
searchEl?.addEventListener('input', () => applyFilter());

/* Tabs click */
tabsEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  currentTab = btn.dataset.tab || 'recent';
  localStorage.setItem('clip_tab', currentTab);
  rebuildTabs();
  applyFilter();
  if (!cfg.autoPasteOnSelect) { searchEl?.focus(); searchEl?.select(); }
});

/* Row click delegation */
resultsEl?.addEventListener('click', async (e) => {
  // Open URL
  const openBtn = e.target.closest('.open-btn');
  if (openBtn) {
    e.preventDefault(); e.stopPropagation();
    try {
      const id = Number(openBtn.dataset.id);
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
      const id = Number(pinBtn.dataset.id);
      const current = items.find(i => i.id === id);
      if (!current) return;
      await window.api.updateHistoryItem(id, { pinned: !current.pinned });
      items = await window.api.getHistory();
      applyFilter();
    } catch (err) { console.error('[pin] error', err); }
    return;
  }

  // NEW: Collections button 📁
  const colBtn = e.target.closest('.col-btn');
  if (colBtn) {
    e.preventDefault(); e.stopPropagation();
    try {
      const id = Number(colBtn.dataset.id);
      const it = items.find(i => i.id === id);
      if (!it) { console.warn('[collections] item not found for id', id); return; }
      console.log('[collections] folder click on item', id);
      await openCollectionsPromptForItem(it);
    } catch (err) {
      console.error('[collections] col-btn error', err);
      alert('Collections action failed: ' + (err?.message || err));
    }
    return;
  }

  // Delete
  const delBtn = e.target.closest('.del-btn');
  if (delBtn) {
    e.preventDefault(); e.stopPropagation();
    try {
      const id = Number(delBtn.dataset.id);
      await window.api.deleteHistoryItem(id);
      items = await window.api.getHistory();
      applyFilter();
    } catch (err) { console.error('[delete] error', err); }
    return;
  }

  // Row choose (paste/select)
  const row = e.target.closest('li.row');
  if (row) chooseByRow(row);
});


/* Click outside closes */
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.overlay')) window.api.hideOverlay();
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
        <button class="col-rename" data-id="${c.id}" title="Rename">✏️</button>
        <button class="col-delete" data-id="${c.id}" title="Delete">🗑</button>
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

  // Refresh UI
  collections = await window.api.collections.list();
  rebuildTabs();
  applyFilter();
}

/* ---------- Hotkey capture ---------- */
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

/* ---------- Theme ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}
themeEl?.addEventListener('change', () => applyTheme(themeEl.value));

/* ---------- Boot ---------- */
async function boot() {
  items = await window.api.getHistory().catch(() => []);
  try {
    const s = await window.api.getSettings();
    cfg = { ...cfg, ...s };

    if (themeEl) themeEl.value = cfg.theme;
    applyTheme(cfg.theme);

    if (hotkeyEl) {
      hotkeyEl.dataset.accelValue = cfg.hotkey;
      hotkeyEl.value = displayLabel(cfg.hotkey);
    }
    if (maxItemsEl) maxItemsEl.value = cfg.maxItems;
    if (captureEl)  captureEl.checked = !!cfg.captureContext;
    if (searchModeEl)  searchModeEl.value  = cfg.searchMode;
    if (fuzzyThreshEl) fuzzyThreshEl.value = String(cfg.fuzzyThreshold);
    if (autoPasteEl)   autoPasteEl.checked = !!cfg.autoPasteOnSelect;
    if (overlaySizeEl) overlaySizeEl.value = cfg.overlaySize || 'large';
  } catch (e) {
    console.warn('[renderer] getSettings failed:', e?.message);
  }

  // Load collections
  try { collections = await window.api.collections.list(); } catch {}

  filtered = items.slice();
  rebuildTabs();
  render(filtered);
  setSelected(0);
}

window.addEventListener('DOMContentLoaded', async () => {
  await boot();

  enableTabsOverflowUX();   

  // Sanity log so we know the IPC is wired
  console.log('[collections] preload API present =',
    !!(window.api && window.api.collections && window.api.collections.list));

  // live updates
  window.api.onHistoryUpdate((list) => { items = list || []; applyFilter(); });

  // collections live updates
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
    window.api.getHistory().then(h => { items = h || []; applyFilter(); });
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

/* ---------- Settings actions ---------- */
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
    theme: (themeEl?.value || cfg.theme),
    hotkey: (hotkeyEl?.dataset?.accelValue || hotkeyEl?.value || cfg.hotkey || 'CommandOrControl+Shift+Space'),
    maxItems: Number(maxItemsEl?.value || cfg.maxItems || 500),
    captureContext: !!(captureEl?.checked ?? cfg.captureContext),
    searchMode: (searchModeEl?.value || cfg.searchMode),
    fuzzyThreshold: Number(fuzzyThreshEl?.value || cfg.fuzzyThreshold || 0.4),
    autoPasteOnSelect: !!(autoPasteEl?.checked ?? cfg.autoPasteOnSelect),
    overlaySize: (overlaySizeEl?.value || cfg.overlaySize || 'large'),
  };
  cfg = { ...cfg, ...payload };
  try {
    await window.api.saveSettings(payload);
    await window.api.resizeOverlay(payload.overlaySize); // apply size now
  } catch {}
  settingsEl?.classList.remove('open');
  applyTheme(cfg.theme);
  applyFilter();
});

/* ---------- Settings flyout & Esc handling (keeps top-right sheet UX) ---------- */
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

/* ---------- END ---------- */
