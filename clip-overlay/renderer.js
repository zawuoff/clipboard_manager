// renderer.js

/* ---------- DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);

/* Core elements */
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
const overlayCard = document.querySelector('.overlay');

/* Tabs */
const tabsEl = $('#tabs');

/* Hotkey record buttons */
const recordHotkeyBtn = $('#recordHotkey');
const resetHotkeyBtn  = $('#resetHotkey');

/* Search (settings) */
const searchModeEl   = $('#searchMode');
const fuzzyThreshEl  = $('#fuzzyThreshold');
const fuzzyThreshVal = $('#fuzzyThresholdValue');

/* ---------- State ---------- */
let items = [];
let filtered = [];
let selectedIndex = 0;
let cfg = { searchMode: 'fuzzy', fuzzyThreshold: 0.5 };
let currentTab = localStorage.getItem('clip_tab') || 'recent';
let recordingHotkey = false;

/* ---------- Utils ---------- */
function escapeHTML(s='') {
  return String(s).replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function trimOneLine(s='') {
  const t = s.trim().replace(/\s+/g,' ');
  return t.length>260 ? t.slice(0,260)+'…' : t;
}
function highlightPrimary(text, matches) {
  if (!matches || !matches.length) return escapeHTML(trimOneLine(text));
  const m = matches.find(x => x.key === 'text');
  if (!m) return escapeHTML(trimOneLine(text));
  const oneLine = trimOneLine(text);
  let html = ''; let last = 0; const maxLen = oneLine.length;
  (m.indices || []).forEach(([start,end]) => {
    if (start >= maxLen) return;
    const s = Math.max(0, start); const e = Math.min(maxLen - 1, end); if (e < 0) return;
    html += escapeHTML(oneLine.slice(last, s));
    html += `<mark>${escapeHTML(oneLine.slice(s, e + 1))}</mark>`;
    last = e + 1;
  });
  html += escapeHTML(oneLine.slice(last));
  return html;
}

/* ---------- URL helpers ---------- */
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
const URL_EXTRACT_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
function extractUrlFromText(text = "") {
  const m = String(text).match(URL_EXTRACT_RE);
  if (!m) return null;
  let url = m[0];
  url = url.replace(/[)\]\}>,.;!?]+$/g, ''); // trim trailing punctuation
  return url;
}
const isUrlItem = (it) => it.type === 'text' && URL_RE.test(String(it.text || ''));

/* ---------- Rendering ---------- */
function render(list) {
  resultsEl.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<div class="primary">No items</div><div class="meta">Try another tab or clear search.</div>`;
    resultsEl.appendChild(li);
    return;
  }

  list.forEach((it, idx) => {
    const li = document.createElement('li');
    li.className = 'row' + (idx === selectedIndex ? ' selected' : '');

    if (it.type === 'image') {
      // Image row
      li.classList.add('image');
      const dims = it.wh ? ` ${it.wh.w}×${it.wh.h}` : '';
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      li.innerHTML = `
        <div class="thumbwrap">
          <img class="thumb" src="${it.thumb}" alt="Clipboard image${dims}" />
        </div>
        <div class="cell">
          <div class="primary">Image${dims}</div>
          <div class="meta">
            ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
            <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">${it.pinned ? '⭐' : '☆'}</button>
            <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
          </div>
        </div>
      `;
    } else {
      // Text row (URL gets an "Open" button)
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      const primaryHTML = it._matches ? highlightPrimary(it.text, it._matches) : escapeHTML(trimOneLine(it.text));
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
}

/* ---------- Tab scoping + sorting ---------- */
function scopeByTab(all, tab) {
  switch (tab) {
    case 'images': return all.filter(i => i.type === 'image');
    case 'urls':   return all.filter(isUrlItem);
    case 'pinned': return all.filter(i => !!i.pinned);
    case 'recent':
    default:       return all.slice();
  }
}
function sortCombined(list) {
  list.sort((a,b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    (a._score ?? 1) - (b._score ?? 1) ||
    new Date(b.ts) - new Date(a.ts)
  );
}

/* ---------- Filter (search + tab) ---------- */
async function applyFilter() {
  const q = searchEl.value.trim();
  const scope = scopeByTab(items, currentTab);

  const texts = scope.filter(i => i.type !== 'image');
  const imgs  = scope.filter(i => i.type === 'image');

  if (!q) {
    filtered = scope.slice();
    sortCombined(filtered);
  } else {
    // text search via preload (fuzzy/exact)
    const textResults = await window.api.fuzzySearch(texts, q, {
      mode: cfg.searchMode,
      threshold: cfg.fuzzyThreshold,
    });

    // image "search" via metadata (dims/app/title)
    let imgResults = [];
    if (imgs.length) {
      const qq = q.toLowerCase();
      imgResults = imgs.filter(it => {
        const dims = it.wh ? `${it.wh.w}x${it.wh.h}` : '';
        const hay = `${dims} ${it?.source?.app || ''} ${it?.source?.title || ''}`.toLowerCase();
        return hay.includes(qq);
      }).map(it => ({ ...it, _score: 0.6, _matches: [] }));
    }

    filtered = [...textResults, ...imgResults];
    sortCombined(filtered);
  }

  selectedIndex = 0;
  render(filtered);
}

/* ---------- Choose (copy/paste) ---------- */
function chooseByRow(rowEl) {
  const index = Array.from(resultsEl.children).indexOf(rowEl);
  if (index < 0) return;
  const it = filtered[index];
  if (!it) return;

  if (it.type === 'image' && it.filePath) {
    window.api.setClipboard({ imagePath: it.filePath });
  } else {
    window.api.setClipboard({ text: it.text });
  }
  window.api.hideOverlay();
}

/* ---------- Hotkey recorder ---------- */
function keyFromEvent(e) {
  const c = e.code;

  // Letters / Digits
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);

  // Function keys
  if (/^F[1-9][0-9]?$/.test(e.key)) return e.key.toUpperCase();

  // Arrows
  if (c === 'ArrowUp') return 'Up';
  if (c === 'ArrowDown') return 'Down';
  if (c === 'ArrowLeft') return 'Left';
  if (c === 'ArrowRight') return 'Right';

  // Editing / control
  const map = {
    Escape: 'Esc',
    Enter: 'Enter',
    Space: 'Space',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    PrintScreen: 'PrintScreen',
    CapsLock: 'CapsLock',
    ContextMenu: 'ContextMenu',
  };
  if (map[c]) return map[c];

  // Numpad
  if (/^Numpad[0-9]$/.test(c)) return 'num' + c.slice(6);
  const numMap = {
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
  };
  if (numMap[c]) return numMap[c];

  // Punctuation (common)
  const punct = {
    Minus: 'Minus',
    Equal: 'Plus',
    Backquote: 'Backquote',
    BracketLeft: 'BracketLeft',
    BracketRight: 'BracketRight',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
    Backslash: 'Backslash',
  };
  if (punct[c]) return punct[c];

  return '';
}

function buildAcceleratorFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Super');
  if (e.getModifierState && e.getModifierState('AltGraph')) mods.push('AltGr');

  const base = keyFromEvent(e);
  if (!base) return '';
  return mods.concat(base).join('+');
}

function startRecordingHotkey() {
  if (recordingHotkey) return;
  recordingHotkey = true;
  recordHotkeyBtn.classList.add('recording');
  recordHotkeyBtn.textContent = 'Recording…';
  hotkeyEl.value = 'Press keys… (Esc to cancel)';

  const onKeyDown = (e) => {
    // capture at window level so inputs can’t swallow it
    e.preventDefault();
    e.stopPropagation();

    // cancel / confirm
    if (e.key === 'Escape') return stop(false);
    if (e.key === 'Enter')  return stop(true);

    const acc = buildAcceleratorFromEvent(e);
    if (acc) {
      hotkeyEl.value = acc;
      stop(true); // auto-finish once a valid base key is pressed
    }
  };

  function stop(keepValue) {
    recordingHotkey = false;
    recordHotkeyBtn.classList.remove('recording');
    recordHotkeyBtn.textContent = 'Rec';
    if (!keepValue) hotkeyEl.value = cfg.hotkey || '';
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  // capture phase listeners (belt & suspenders)
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keydown', onKeyDown, true);
}

/* ---------- Boot ---------- */
async function boot() {
  items = await window.api.getHistory();

  const s = await window.api.getSettings();
  cfg = {
    hotkey: s.hotkey,
    maxItems: s.maxItems,
    captureContext: !!s.captureContext,
    theme: s.theme || 'light',
    searchMode: s.searchMode || 'fuzzy',
    fuzzyThreshold: Number.isFinite(+s.fuzzyThreshold) ? +s.fuzzyThreshold : 0.5,
  };

  hotkeyEl.value = cfg.hotkey || '';
  maxItemsEl.value = cfg.maxItems || 500;
  captureEl.checked = !!cfg.captureContext;
  searchModeEl.value = cfg.searchMode;
  fuzzyThreshEl.value = String(cfg.fuzzyThreshold);
  fuzzyThreshVal.textContent = cfg.fuzzyThreshold.toFixed(2);

  // Tabs init & selection
  if (tabsEl) {
    const btns = Array.from(tabsEl.querySelectorAll('.tab'));
    btns.forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      currentTab = btn.dataset.tab || 'recent';
      localStorage.setItem('clip_tab', currentTab);
      btns.forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
      applyFilter();
    });
  }

  applyFilter();
}
boot();

/* ---------- IPC ---------- */
window.api.onHistoryUpdate((latest) => { items = latest; applyFilter(); });
window.api.onOverlayShow(async () => {
  items = await window.api.getHistory();
  applyFilter();
  searchEl.focus();
  searchEl.select();
});
window.api.onOverlayAnim((visible) => overlayCard?.classList.toggle('show', !!visible));

/* ---------- UI actions ---------- */
clearBtn.onclick = async () => {
  await window.api.clearHistory();
  items = [];
  applyFilter();
};
settingsBtn.onclick = () => {
  settingsEl.classList.add('open');
  settingsEl.querySelector('input,select,button,textarea')?.focus();
};
closeBtn.onclick = () => settingsEl.classList.remove('open');
saveBtn.onclick = async () => {
  const payload = {
    hotkey: hotkeyEl.value,
    maxItems: Number(maxItemsEl.value || 500),
    captureContext: !!captureEl.checked,
    theme: 'light',
    searchMode: searchModeEl.value,
    fuzzyThreshold: Number(fuzzyThreshEl.value || 0.5),
  };
  await window.api.saveSettings(payload);   // main.js calls registerHotkey()
  cfg.hotkey = payload.hotkey;
  cfg.searchMode = payload.searchMode;
  cfg.fuzzyThreshold = payload.fuzzyThreshold;
  settingsEl.classList.remove('open');
};

fuzzyThreshEl?.addEventListener('input', () => {
  fuzzyThreshVal.textContent = Number(fuzzyThreshEl.value).toFixed(2);
});

/* Hotkey recording buttons */
recordHotkeyBtn?.addEventListener('click', () => startRecordingHotkey());
resetHotkeyBtn?.addEventListener('click', () => {
  hotkeyEl.value = 'CommandOrControl+Shift+Space';
});

/* ---------- Keyboard (list navigation) ---------- */
document.addEventListener('keydown', (e) => {
  if (recordingHotkey) return; // don't steal keys while recording
  if (e.key === 'Escape') { window.api.hideOverlay(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1); render(filtered); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); render(filtered); return; }
  if (e.key === 'Enter') {
    const row = resultsEl.children[selectedIndex];
    if (row) chooseByRow(row);
  }
});

/* ---------- Search ---------- */
searchEl.addEventListener('input', () => applyFilter());

/* ---------- Click delegation (open url / pin / delete / choose) ---------- */
resultsEl.addEventListener('click', async (e) => {
  // Open URL button
  const openBtn = e.target.closest('.open-btn');
  if (openBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(openBtn.dataset.id);
    const current = items.find(i => i.id === id);
    if (current) {
      const url = extractUrlFromText(current.text);
      if (url) window.api.openUrl(url);
    }
    return;
  }

  // Pin toggle
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

  // Delete
  const delBtn = e.target.closest('.del-btn');
  if (delBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(delBtn.dataset.id);
    await window.api.deleteHistoryItem(id);
    items = await window.api.getHistory();
    applyFilter();
    return;
  }

  // Row click -> copy
  const row = e.target.closest('li.row');
  if (row) chooseByRow(row);
});

/* ---------- Click outside card closes ---------- */
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.overlay')) window.api.hideOverlay();
});
