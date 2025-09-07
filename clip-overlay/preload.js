//this is preload.js
const { contextBridge, ipcRenderer } = require('electron');

let Fuse = null;
try {
  Fuse = require('fuse.js');
  console.log('[preload] Fuse.js loaded successfully');
} catch (e) {
  console.warn('[preload] Fuse.js not loaded, falling back:', e?.message);
}

/* -------- Fuzzy / Exact engine -------- */
function fuzzyEngine(items, query, opts = {}) {
  const arr = Array.isArray(items) ? items : [];
  const q = String(query || '').trim();
  const mode = (opts.mode === 'exact') ? 'exact' : 'fuzzy';
  const threshold = Number.isFinite(+opts.threshold) ? +opts.threshold : 0.5;

  if (!q) return arr.map(it => ({ ...it, _score: null, _matches: null }));

  // Only text items are searched; images show when query is empty.
  const textItems = arr.filter(i => i.type !== 'image');

  if (mode === 'exact' || !Fuse) {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const keep = textItems.filter(it => {
      const hay = [
        String(it.text || '').toLowerCase(),
        String(it?.source?.title || '').toLowerCase(),
        String(it?.source?.app || '').toLowerCase(),
      ].join(' ');
      return tokens.every(t => hay.includes(t));
    });
    return keep.map(it => ({ ...it, _score: 0.5, _matches: [] }));
  }

  const fuse = new Fuse(textItems, {
    includeScore: true,
    includeMatches: true,
    threshold,
    distance: 300,
    findAllMatches: true,
    ignoreLocation: true,
    minMatchCharLength: 1,
    keys: [
      { name: 'text', weight: 0.85 },
      { name: 'source.title', weight: 0.10 },
      { name: 'source.app', weight: 0.05 },
    ],
  });

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return fuse.search(q).map(r => ({
      ...r.item, _score: r.score ?? 1, _matches: r.matches || [],
    }));
  }

  const maps = tokens.map(t => {
    const m = new Map();
    fuse.search(t).forEach(r => {
      const key = r.item.id ?? r.item.text;
      const prev = m.get(key);
      const score = r.score ?? 1;
      const matches = r.matches || [];
      if (!prev || score < prev.score) m.set(key, { item: r.item, score, matches });
    });
    return m;
  });

  const first = maps[0];
  const out = [];
  for (const [key, e] of first.entries()) {
    if (maps.every(m => m.has(key))) {
      const scores = maps.map(m => m.get(key).score);
      const matches = maps.flatMap(m => m.get(key).matches);
      const avg = scores.reduce((a,b)=>a+b,0)/scores.length;
      out.push({ ...e.item, _score: avg, _matches: matches });
    }
  }
  return out;
}

/* -------- Bridge -------- */
contextBridge.exposeInMainWorld('api', {
  // History
  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  updateHistoryItem: (id, patch) => ipcRenderer.invoke('history:updateItem', { id, patch }),
  deleteHistoryItem: (id) => ipcRenderer.invoke('delete-history-item', id),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  // Clipboard / overlay
  setClipboard: (data) => ipcRenderer.invoke('clipboard:set', data),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),

  // Events
  onHistoryUpdate: (fn) => ipcRenderer.on('history:update', (_e, items) => fn(items)),
  onOverlayShow:  (fn) => ipcRenderer.on('overlay:show', () => fn()),
  onOverlayAnim:  (fn) => ipcRenderer.on('overlay:anim', (_e, v) => fn(v)),

  // Search
  fuzzySearch: (items, query, opts) => fuzzyEngine(items, query, opts),

  // Open URL
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  //resize
  resizeOverlay: (size) => ipcRenderer.invoke('overlay:resize', size),
  
  // Collections
  collections: {
  list: () => ipcRenderer.invoke('collections:list'),
  create: (name) => ipcRenderer.invoke('collections:create', name),
  rename: (id, name) => ipcRenderer.invoke('collections:rename', { id, name }),
  remove: (id) => ipcRenderer.invoke('collections:delete', id),
  addItems: (id, itemIds) => ipcRenderer.invoke('collections:addItems', { id, itemIds }),
  removeItems: (id, itemIds) => ipcRenderer.invoke('collections:removeItems', { id, itemIds }),
  onUpdate: (fn) => ipcRenderer.on('collections:update', (_e, list) => fn(list)),
},


});
