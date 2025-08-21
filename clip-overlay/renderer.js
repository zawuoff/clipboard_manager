const $ = (sel) => document.querySelector(sel);

/* DOM refs */
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

/* New settings refs */
const searchModeEl   = $('#searchMode');
const fuzzyThreshEl  = $('#fuzzyThreshold');
const fuzzyThreshVal = $('#fuzzyThresholdValue');

let items = [];
let filtered = [];
let selectedIndex = 0;
let cfg = { searchMode: 'fuzzy', fuzzyThreshold: 0.5 };

/* Utils */
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

/* Render */
function render(list) {
  resultsEl.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<div class="primary">No matching items</div><div class="meta">Try a different query or clear search.</div>`;
    resultsEl.appendChild(li);
    return;
  }

  list.forEach((it, idx) => {
    const li = document.createElement('li');
    li.className = 'row' + (idx === selectedIndex ? ' selected' : '');

    if (it.type === 'image') {
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
      const ctx = it.source ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}` : '';
      const primaryHTML = it._matches ? highlightPrimary(it.text, it._matches) : escapeHTML(trimOneLine(it.text));
      li.innerHTML = `
        <div class="primary">${primaryHTML}</div>
        <div class="meta">
          ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
          <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">${it.pinned ? '⭐' : '☆'}</button>
          <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
        </div>
      `;
    }

    resultsEl.appendChild(li);
  });
}

/* Filtering */
async function applyFilter() {
  const q = searchEl.value.trim();
  if (!q) {
    filtered = items.slice();
  } else {
    const results = await window.api.fuzzySearch(items, q, {
      mode: cfg.searchMode,
      threshold: cfg.fuzzyThreshold,
    });
    // images are intentionally excluded from search; results already only include text items
    filtered = results;
  }
  selectedIndex = 0;
  render(filtered);
}

/* Choose */
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

/* Boot */
async function boot() {
  items = await window.api.getHistory();
  filtered = items.slice();

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

  render(filtered);
}
boot();

/* IPC */
window.api.onHistoryUpdate((latest) => { items = latest; applyFilter(); });
window.api.onOverlayShow(async () => {
  items = await window.api.getHistory();
  applyFilter();
  searchEl.focus();
  searchEl.select();
});
window.api.onOverlayAnim((visible) => overlayCard?.classList.toggle('show', !!visible));

/* UI */
clearBtn.onclick = async () => { await window.api.clearHistory(); items = []; applyFilter(); };
settingsBtn.onclick = () => { settingsEl.classList.add('open'); settingsEl.querySelector('input,select,button,textarea')?.focus(); };
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
  await window.api.saveSettings(payload);
  cfg.searchMode = payload.searchMode;
  cfg.fuzzyThreshold = payload.fuzzyThreshold;
  settingsEl.classList.remove('open');
  applyFilter();
};
fuzzyThreshEl?.addEventListener('input', () => {
  fuzzyThreshVal.textContent = Number(fuzzyThreshEl.value).toFixed(2);
});

/* keyboard */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.api.hideOverlay(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1); render(filtered); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); render(filtered); return; }
  if (e.key === 'Enter') {
    const row = resultsEl.children[selectedIndex];
    if (row) chooseByRow(row);
  }
});

/* search input */
searchEl.addEventListener('input', () => applyFilter());

/* clicks (delegate) */
resultsEl.addEventListener('click', async (e) => {
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

/* click outside closes */
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.overlay')) window.api.hideOverlay();
});
