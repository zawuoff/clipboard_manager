// ---------- Helpers / refs ----------
const $ = (sel) => document.querySelector(sel);

const resultsEl    = $('#results');
const searchEl     = $('#search');
const settingsEl   = $('#settings');
const hotkeyEl     = $('#hotkey');
const maxItemsEl   = $('#maxItems');
const captureEl    = $('#captureContext');
const clearBtn     = $('#clearBtn');
const settingsBtn  = $('#settingsBtn');
const saveBtn      = $('#saveSettings');
const closeBtn     = $('#closeSettings');
const backdropEl   = $('#backdrop');
const overlayCard  = document.querySelector('.overlay');

let items = [];
let filtered = [];
let selectedIndex = 0;

// ---------- Utils ----------
function escapeHTML(s='') {
  return String(s).replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function trimOneLine(s='') {
  const t = s.trim().replace(/\s+/g,' ');
  return t.length>140 ? t.slice(0,140)+'…' : t;
}

// ---------- Render ----------
function render(list) {
  resultsEl.innerHTML = '';

  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `
      <div class="primary">No items yet</div>
      <div class="meta">Copy something (Ctrl+C), then hit your hotkey to find it fast.</div>
    `;
    resultsEl.appendChild(li);
    return;
  }

  list.forEach((it, idx) => {
    const li = document.createElement('li');
    li.className = 'row' + (idx === selectedIndex ? ' selected' : '');

    const ctx = it.source
      ? ` • ${it.source.app ?? ''}${it.source.title ? ' - ' + it.source.title : ''}`
      : '';

    li.innerHTML = `
      <div class="primary">${escapeHTML(trimOneLine(it.text))}</div>
      <div class="meta">
        ${new Date(it.ts || Date.now()).toLocaleString()}${ctx}
        <button class="pin-btn" data-id="${it.id}" title="${it.pinned ? 'Unpin' : 'Pin'}">
          ${it.pinned ? '⭐' : '☆'}
        </button>
        <button class="del-btn" data-id="${it.id}" title="Delete">🗑</button>
      </div>
    `;
    resultsEl.appendChild(li);
  });
}

// ---------- Filtering ----------
function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) {
    filtered = items.slice();
  } else {
    filtered = items.filter(it => (it.text || '').toLowerCase().includes(q));
  }
  selectedIndex = 0;
  render(filtered);
}

// ---------- Choose / copy ----------
function chooseByRow(rowEl) {
  const index = Array.from(resultsEl.children).indexOf(rowEl);
  if (index < 0) return;
  const it = filtered[index];
  if (!it) return;
  window.api.setClipboard({ text: it.text });
  window.api.hideOverlay();
}

// ---------- Boot ----------
async function boot() {
  items = await window.api.getHistory();
  filtered = items.slice();

  const s = await window.api.getSettings();
  hotkeyEl.value = s.hotkey || '';
  maxItemsEl.value = s.maxItems || 500;
  captureEl.checked = !!s.captureContext;

  render(filtered);
}
boot();

// ---------- IPC listeners ----------
window.api.onHistoryUpdate(async (latest) => {
  items = latest;
  applyFilter();
});

window.api.onOverlayShow(async () => {
  items = await window.api.getHistory();
  applyFilter();
  searchEl.focus();
  searchEl.select();
});

window.api.onOverlayAnim((visible) => {
  overlayCard?.classList.toggle('show', !!visible);
});

// ---------- UI ----------
clearBtn.onclick = async () => {
  await window.api.clearHistory();
  items = [];
  applyFilter();
};

settingsBtn.onclick = () => openSettings();
closeBtn.onclick = () => closeSettings();
saveBtn.onclick = async () => {
  await window.api.saveSettings({
    hotkey: hotkeyEl.value.trim() || 'CommandOrControl+Shift+Space',
    maxItems: Math.max(50, Math.min(5000, parseInt(maxItemsEl.value || '500', 10))),
    captureContext: !!captureEl.checked,
  });
  closeSettings();
  searchEl.focus();
};

function openSettings() {
  settingsEl.classList.remove('hidden');
  document.body.classList.add('settings-open');
  hotkeyEl.focus();
}
function closeSettings() {
  settingsEl.classList.add('hidden');
  document.body.classList.remove('settings-open');
}

searchEl.addEventListener('input', applyFilter);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!settingsEl.classList.contains('hidden')) closeSettings();
    else window.api.hideOverlay();
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!filtered.length) return;
    selectedIndex = (selectedIndex + 1) % filtered.length;
    render(filtered);
    resultsEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!filtered.length) return;
    selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
    render(filtered);
    resultsEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const row = resultsEl.children[selectedIndex];
    if (row) chooseByRow(row);
  }
});

backdropEl.onclick = () => {
  if (!settingsEl.classList.contains('hidden')) closeSettings();
  else window.api.hideOverlay();
};

// ---------- Delegated clicks (pin, delete, row) ----------
resultsEl.addEventListener('click', async (e) => {
  // delete
  const delBtn = e.target.closest('.del-btn');
  if (delBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = Number(delBtn.dataset.id);
    await window.api.deleteHistoryItem(id);
    items = await window.api.getHistory();
    applyFilter();
    return;
  }

  // pin
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

  // row select
  const row = e.target.closest('li.row');
  if (row) chooseByRow(row);
});
