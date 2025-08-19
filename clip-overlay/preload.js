const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // history
  getHistory:        () => ipcRenderer.invoke('history:get'),
  clearHistory:      () => ipcRenderer.invoke('history:clear'),
  updateHistoryItem: (id, patch) => ipcRenderer.invoke('history:updateItem', { id, patch }),
  deleteHistoryItem: (id) => ipcRenderer.invoke('delete-history-item', id),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  // clipboard/set + overlay
  setClipboard: (data) => ipcRenderer.invoke('clipboard:set', data),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),

  // events from main
  onHistoryUpdate: (cb) => ipcRenderer.on('history:update', (_e, items) => cb(items)),
  onOverlayShow:   (cb) => ipcRenderer.on('overlay:show', cb),
  onOverlayAnim:   (cb) => ipcRenderer.on('overlay:anim', (_e, v) => cb(v)),
  onOpenSettings:  (cb) => ipcRenderer.on('overlay:settings', cb),
});
