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

const searchModeEl  = $('#searchMode');
const fuzzyThreshEl = $('#fuzzyThreshold');

const autoPasteEl   = $('#autoPasteOnSelect'); // paste on select toggle
const overlaySizeEl = $('#overlaySize');       // overlay size select

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
  overlaySize: 'large',
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

      const metaHTML = `
        ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
        ${iconBtn('pin-btn', 'star', it.pinned ? 'Unpin' : 'Pin', it.pinned, it.id)}
        ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
        ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
        ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
      `;

      li.innerHTML = `
        <div class="thumbwrap">
          <img class="thumb" src="${it.thumb}" alt="Clipboard image${dims}" />
        </div>
        <div class="cell">
          <div class="primary">Image${dims}</div>
          ${ocrHTML}
          <div class="tags"></div>
          <div class="meta">${metaHTML}</div>
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
        ${iconBtn('stack-btn', 'stack', inPasteStack(it.id) ? 'Remove from Paste Stack' : 'Add to Paste Stack', inPasteStack(it.id), it.id)}
        ${iconBtn('col-btn', 'folder', 'Add/remove in collections', false, it.id)}
        ${iconBtn('del-btn', 'trash', 'Delete', false, it.id)}
      `;

      li.innerHTML = `
        <div class="primary">${primaryHTML}</div>
        <div class="tags"></div>
        <div class="meta">${metaHTML}</div>
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

/* ---------- Sidebar Tabs (with collections) ---------- */
function rebuildTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = `
    <button class="sidebar-tab" data-tab="recent">
      <span class="tab-icon">🕒</span>
      <span class="tab-label">Recent</span>
    </button>
    <button class="sidebar-tab" data-tab="images">
      <span class="tab-icon">🖼️</span>
      <span class="tab-label">Images</span>
    </button>
    <button class="sidebar-tab" data-tab="urls">
      <span class="tab-icon">🔗</span>
      <span class="tab-label">URLs</span>
    </button>
    <button class="sidebar-tab" data-tab="pinned">
      <span class="tab-icon">📌</span>
      <span class="tab-label">Pinned</span>
    </button>
    <button class="sidebar-tab" data-tab="collections">
      <span class="tab-icon">📁</span>
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

/* ---------- Filter + Search ---------- */
function applyFilter() {
  // Collections hub view
  if (currentTab === 'collections') {
    rebuildTabs();
    renderCollectionsHub();
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

/* Search input */
searchEl?.addEventListener('input', () => applyFilter());

/* Sidebar tabs click */
tabsEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('.sidebar-tab');
  if (!btn) return;
  currentTab = btn.dataset.tab || 'recent';
  localStorage.setItem('clip_tab', currentTab);
  rebuildTabs();
  applyFilter();
  if (!cfg.autoPasteOnSelect) { searchEl?.focus(); searchEl?.select(); }
});

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

/* ---------- Theme ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}
themeEl?.addEventListener('change', () => applyTheme(themeEl.value));

/* ---------- Boot ---------- */
async function boot() {
  // Restore stack from session (optional)
  try {
    const saved = JSON.parse(sessionStorage.getItem('pasteStack') || '[]');
    pasteStack = saved.filter((x) => typeof x === 'number');
    pasteStackIds = new Set(pasteStack);
  } catch {}
  updateStackChip();

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
