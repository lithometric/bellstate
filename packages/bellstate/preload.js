'use strict';

// Electron preload helper: exposes a minimal, safe store API to the renderer
// as window.bellstate. Requires contextIsolation (the default).

const { contextBridge, ipcRenderer } = require('electron');

function exposeBellstate(globalName = 'bellstate') {
  contextBridge.exposeInMainWorld(globalName, {
    snapshot: () => ipcRenderer.invoke('bellstate:snapshot'),
    get: (key) => ipcRenderer.invoke('bellstate:get', key),
    set: (key, value, opts) => ipcRenderer.invoke('bellstate:set', key, value, opts),
    /** Atomic per-property merge; null deletes a field. Conflict-free. */
    merge: (key, partial) => ipcRenderer.invoke('bellstate:merge', key, partial),
    delete: (key) => ipcRenderer.invoke('bellstate:delete', key),
    /** Server-side atomic increment — safe under concurrent writers. */
    incr: (key, by = 1) => ipcRenderer.invoke('bellstate:incr', key, by),
    /** Recent history of a stream (pulses sent with keep). */
    history: (channel, limit) => ipcRenderer.invoke('bellstate:history', channel, limit),
    /** Per-user undo/redo (requires initBellstate({undo: true}) in main). */
    undo: () => ipcRenderer.invoke('bellstate:undo'),
    redo: () => ipcRenderer.invoke('bellstate:redo'),
    /** Subscribe to store events; returns an unsubscribe function. */
    onChange: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('bellstate:change', listener);
      return () => ipcRenderer.removeListener('bellstate:change', listener);
    },
    /** Fire-and-forget transient broadcast; keep:N retains bounded history. */
    pulse: (channel, value, keep) => ipcRenderer.send('bellstate:pulse', channel, value, keep),
    /** Subscribe to pulses on an exact channel or 'prefix*' pattern. */
    watchPulse: (pattern, callback) => {
      const matches = pattern.endsWith('*')
        ? (ch) => ch.startsWith(pattern.slice(0, -1))
        : (ch) => ch === pattern;
      const listener = (_event, payload) => {
        if (payload.type === 'pulse' && matches(payload.ch)) callback(payload);
      };
      ipcRenderer.on('bellstate:change', listener);
      return () => ipcRenderer.removeListener('bellstate:change', listener);
    },
    /** Subscribe to an exact key or 'prefix*' pattern; returns unsubscribe. */
    watch: (pattern, callback) => {
      const matches = pattern.endsWith('*')
        ? (key) => key.startsWith(pattern.slice(0, -1))
        : (key) => key === pattern;
      const listener = (_event, payload) => {
        if (payload.type === 'change' && matches(payload.key)) callback(payload);
      };
      ipcRenderer.on('bellstate:change', listener);
      return () => ipcRenderer.removeListener('bellstate:change', listener);
    },
  });
}

module.exports = { exposeBellstate };
