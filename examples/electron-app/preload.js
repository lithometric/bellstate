'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Generic store stream: snapshot, watch, incr, onChange…
require('bellstate/preload').exposeBellstate();

// App-domain intents; the main process applies them with atomic store ops.
contextBridge.exposeInMainWorld('board', {
  me: () => ipcRenderer.invoke('board:me'),
  add: (partial) => ipcRenderer.invoke('board:add', partial),
  addImage: (payload) => ipcRenderer.invoke('board:add-image', payload),
  patch: (id, patch) => ipcRenderer.invoke('board:patch', { id, patch }),
  front: (id) => ipcRenderer.invoke('board:front', { id }),
  back: (id) => ipcRenderer.invoke('board:back', { id }),
  vault: (text) => ipcRenderer.invoke('board:vault', { text }),
  queue: () => ipcRenderer.invoke('board:queue'),
  remove: (id) => ipcRenderer.invoke('board:delete', { id }),
  grab: (id) => ipcRenderer.invoke('board:grab', { id }),
  drop: (id) => ipcRenderer.invoke('board:drop', { id }),
  cursor: (x, y) => ipcRenderer.invoke('board:cursor', { x, y }),
  template: () => ipcRenderer.invoke('board:template'),
  clear: () => ipcRenderer.invoke('board:clear'),
  crashDaemon: () => ipcRenderer.invoke('board:crash-daemon'),
});
