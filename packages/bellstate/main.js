'use strict';

// Electron main-process helper: connects to the daemon and bridges the store
// to all renderer processes over IPC. Pair with 'bellstate/preload'.

const { ipcMain, BrowserWindow } = require('electron');
const { connect } = require('./client');

const CHANNEL = {
  snapshot: 'bellstate:snapshot',
  get: 'bellstate:get',
  set: 'bellstate:set',
  merge: 'bellstate:merge',
  delete: 'bellstate:delete',
  incr: 'bellstate:incr',
  history: 'bellstate:history',
  undo: 'bellstate:undo',
  redo: 'bellstate:redo',
  change: 'bellstate:change',
};

/**
 * Call once from the main process after app.whenReady().
 * Returns the BellstateClient so main-process code can use the store too.
 */
async function initBellstate(opts = {}) {
  const store = await connect(opts);
  if (opts.undo) store.enableUndo(opts.undo === true ? {} : opts.undo);

  ipcMain.handle(CHANNEL.snapshot, () => ({
    state: store.getAll(),
    rev: store.rev,
    namespace: store.namespace,
  }));
  ipcMain.handle(CHANNEL.get, (_event, key) => store.get(key));
  ipcMain.handle(CHANNEL.set, (_event, key, value, setOpts) => store.set(key, value, setOpts));
  ipcMain.handle(CHANNEL.merge, (_event, key, partial) => store.merge(key, partial));
  ipcMain.handle(CHANNEL.delete, (_event, key) => store.delete(key));
  ipcMain.handle(CHANNEL.incr, (_event, key, by) => store.incr(key, by));
  ipcMain.handle(CHANNEL.history, (_event, channel, limit) => store.history(channel, limit));
  ipcMain.handle(CHANNEL.undo, () => store.undo());
  ipcMain.handle(CHANNEL.redo, () => store.redo());

  const broadcast = (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CHANNEL.change, payload);
    }
  };

  // Transient lane: renderer → daemon pulses use one-way IPC (no invoke
  // round-trip) so high-frequency motion stays cheap end to end.
  ipcMain.on('bellstate:pulse', (_event, channel, value, keep) =>
    store.pulse(channel, value, { keep })
  );

  store.on('pulse', (event) => broadcast({ type: 'pulse', ...event }));
  store.on('change', (change) => broadcast({ type: 'change', ...change }));
  store.on('clear', ({ rev }) => broadcast({ type: 'clear', rev }));
  store.on('sync', ({ state, rev }) => broadcast({ type: 'sync', state, rev }));
  store.on('disconnect', () => broadcast({ type: 'disconnect' }));
  store.on('reconnect', ({ rev }) => broadcast({ type: 'reconnect', rev }));

  return store;
}

module.exports = { initBellstate, CHANNEL };
