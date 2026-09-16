'use strict';

// MultiBoard — a Figma-style multiplayer canvas where the "multiplayer
// server" is just bellstate's machine-global store. Launch it twice
// (npm start / npm run start2) and both windows edit the same board live.
//
// The renderer stays dumb: it sends intents over app-specific IPC, and the
// main process applies them with the store's atomic primitives. State flows
// back to every window through the standard bellstate change stream.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { initBellstate } = require('bellstate/main');
const { orderBetween } = require('bellstate');

const NS = 'multiboard';

// Each launched instance is its own "user" with its own Chromium profile.
const instance =
  (process.argv.find((a) => a.startsWith('--instance=')) || '--instance=1').split('=')[1];
app.setPath('userData', path.join(app.getPath('userData'), `multiboard-${instance}`));

// Identity for this instance — a Figma-style anonymous animal.
const ANIMALS = ['Lynx', 'Otter', 'Heron', 'Fox', 'Orca', 'Ibex', 'Raven', 'Mole'];
const COLORS = ['#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#14B8A6', '#F97316'];
const pick = Math.floor(Math.random() * ANIMALS.length);
const me = {
  name: `${ANIMALS[pick]} ${instance}`,
  color: COLORS[pick],
};
const clientTag = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const cursorKey = `cursor:${clientTag}`;

const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function daemonPidFile() {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, 'bellstate', `${NS}.pid`);
}

let store;
const heldLocks = new Set();

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `MultiBoard — ${me.name}`,
    backgroundColor: '#111113',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload requires the bellstate npm package, which the default
      // renderer sandbox forbids. Context isolation stays on.
      sandbox: false,
      // Never throttle rAF/timers when this window is unfocused or
      // occluded — the interpolation loop must run at display rate on
      // every screen, or remote motion stutters on the inactive window.
      backgroundThrottling: false,
    },
  });
  win.loadFile('index.html');
}

// Current z-order bounds across all shapes (fractional-index strings).
function zBounds() {
  let min = null;
  let max = null;
  for (const key of store.keys('shape:')) {
    const z = store.get(key)?.z;
    if (typeof z !== 'string') continue;
    if (min === null || z < min) min = z;
    if (max === null || z > max) max = z;
  }
  return { min, max };
}

app.whenReady().then(async () => {
  store = await initBellstate({
    namespace: NS,
    idleTimeout: 120,
    // Encrypted-at-rest values (the shared vault note) — machine key file.
    secure: true,
    // Per-user undo/redo, exposed to the renderer via window.bellstate.
    undo: true,
  });

  // Presence: visible to every process on the machine, auto-removed when
  // this app quits or crashes (the key is ephemeral).
  await store.presence('board', me);
  // Join toast: a TTL key — every window shows it until it expires.
  await store.set(
    `toast:${clientTag}`,
    { text: `${me.name} joined the board` },
    { ttl: 3500, noRecord: true }
  );

  ipcMain.handle('board:me', () => ({ ...me, cursorKey }));

  ipcMain.handle('board:add', async (_e, partial) => {
    const id = newId();
    // Fractional-index z-order: a key after the current top, conflict-free
    // even when two apps add shapes at the same instant.
    const z = orderBetween(zBounds().max, null);
    await store.set(`shape:${id}`, { id, z, ...partial });
    await store.incr('stat:created');
    return id;
  });

  ipcMain.handle('board:add-image', async (_e, { dataUrl, x, y, w, h }) => {
    const id = newId();
    const z = orderBetween(zBounds().max, null);
    // Big images take the chunked path automatically; other windows get the
    // shape immediately and the pixels stream in behind it.
    await store.set(`asset:${id}`, dataUrl);
    await store.set(`shape:${id}`, { id, type: 'image', assetId: id, x, y, w, h, z });
    await store.incr('stat:created');
    return id;
  });

  ipcMain.handle('board:patch', async (_e, { id, patch }) => {
    // Per-property merge: one app moving a shape while another recolors it
    // combines both — no CAS retries, no lost fields, by construction.
    if (!store.has(`shape:${id}`)) return false;
    await store.merge(`shape:${id}`, patch);
    return true;
  });

  ipcMain.handle('board:front', async (_e, { id }) => {
    if (!store.has(`shape:${id}`)) return;
    await store.merge(`shape:${id}`, { z: orderBetween(zBounds().max, null) });
  });

  ipcMain.handle('board:back', async (_e, { id }) => {
    if (!store.has(`shape:${id}`)) return;
    await store.merge(`shape:${id}`, { z: orderBetween(null, zBounds().min) });
  });

  ipcMain.handle('board:vault', async (_e, { text }) => {
    // Shared secret note: plaintext in every window that holds the machine
    // key, ciphertext in the snapshot, the WAL, and any key-less client.
    await store.set(
      'vault:note',
      { text, by: me.name, at: Date.now() },
      { secure: true, noRecord: true }
    );
  });

  ipcMain.handle('board:queue', () => store.offlineQueueSize);

  ipcMain.handle('board:delete', async (_e, { id }) => {
    const shape = store.get(`shape:${id}`);
    await store.delete(`shape:${id}`);
    if (shape?.assetId) await store.delete(`asset:${shape.assetId}`);
    await store.delete(`lock:shape:${id}`);
    heldLocks.delete(id);
  });

  ipcMain.handle('board:grab', async (_e, { id }) => {
    // Machine-global lock, released automatically if this app dies mid-drag.
    const ok = await store.acquire(`lock:shape:${id}`, me);
    if (ok) heldLocks.add(id);
    return ok;
  });

  ipcMain.handle('board:drop', async (_e, { id }) => {
    if (heldLocks.delete(id)) await store.release(`lock:shape:${id}`);
  });

  ipcMain.handle('board:cursor', (_e, { x, y }) =>
    // Ephemeral (dies with the app) + TTL (dies if the app hangs).
    store.set(cursorKey, { x, y, ...me }, { ephemeral: true, ttl: 4000 }).catch(() => {})
  );

  ipcMain.handle('board:template', async () => {
    // Four shapes land in ONE revision — no window ever sees half a template.
    const z = [];
    let top = zBounds().max;
    for (let i = 0; i < 4; i++) {
      top = orderBetween(top, null);
      z.push(top);
    }
    const t = newId();
    await store.mset({
      [`shape:${t}-a`]: { id: `${t}-a`, type: 'rect', x: 120, y: 140, w: 300, h: 190, fill: '#8B5CF6', z: z[0] },
      [`shape:${t}-b`]: { id: `${t}-b`, type: 'ellipse', x: 480, y: 160, w: 170, h: 170, fill: '#F59E0B', z: z[1] },
      [`shape:${t}-c`]: { id: `${t}-c`, type: 'rect', x: 190, y: 380, w: 460, h: 110, fill: '#10B981', z: z[2] },
      [`shape:${t}-d`]: { id: `${t}-d`, type: 'note', x: 700, y: 200, w: 220, h: 150, fill: '#FEF3C7', text: 'Double-click to edit me', z: z[3] },
    });
    await store.incr('stat:created', 4);
  });

  ipcMain.handle('board:clear', async () => {
    // Atomic wipe of the artwork only — presence, cursors, and stats survive.
    const del = [
      ...store.keys('shape:'),
      ...store.keys('asset:'),
      ...store.keys('lock:shape:'),
    ];
    heldLocks.clear();
    if (del.length) await store.mset({}, { del });
  });

  ipcMain.handle('board:crash-daemon', () => {
    // Resilience demo: SIGKILL the daemon; every window shows "reconnecting…"
    // then recovers with the full board intact (WAL + auto-respawn).
    try {
      const pid = Number(fs.readFileSync(daemonPidFile(), 'utf8'));
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
