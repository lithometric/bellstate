// Angular signals over the window.bellstate renderer API (exposed by
// 'bellstate/preload'). A single renderer-side replica is built from one
// snapshot + one onChange subscription, shared by every signal instance.

import { signal, computed } from '@angular/core';

let replica = null;

function getReplica() {
  if (replica) return replica;
  if (typeof window === 'undefined' || !window.bellstate) {
    throw new Error(
      'bellstate-angular: window.bellstate is missing. Call exposeBellstate() ' +
        "from your preload script (require('bellstate/preload')) and create " +
        'the window with sandbox: false.'
    );
  }

  const state = new Map();
  // Bumped on every store event; per-key computeds re-read the map and
  // Object.is-dedupe, so only signals whose key actually changed notify.
  const version = signal(0);
  const connected = signal(false);
  const rev = signal(0);

  window.bellstate.onChange((payload) => {
    if (payload.type === 'change') {
      rev.set(payload.rev);
      if (payload.deleted) state.delete(payload.key);
      else state.set(payload.key, payload.value);
    } else if (payload.type === 'sync') {
      rev.set(payload.rev);
      state.clear();
      for (const [k, v] of Object.entries(payload.state)) state.set(k, v);
      connected.set(true);
    } else if (payload.type === 'clear') {
      rev.set(payload.rev);
      state.clear();
    } else if (payload.type === 'disconnect') {
      connected.set(false);
    } else if (payload.type === 'reconnect') {
      connected.set(true);
    }
    version.update((n) => n + 1);
  });

  window.bellstate.snapshot().then((snap) => {
    rev.set(snap.rev);
    for (const [k, v] of Object.entries(snap.state)) {
      if (!state.has(k)) state.set(k, v);
    }
    connected.set(true);
    version.update((n) => n + 1);
  });

  replica = { state, version, connected, rev };
  return replica;
}

/**
 * Live machine-global value as a read-only Signal. Updates whenever any
 * process on the machine writes the key. Write with setBellstate().
 */
export function bellstateSignal(key, initialValue) {
  const { state, version } = getReplica();
  return computed(() => {
    version();
    return state.has(key) ? state.get(key) : initialValue;
  });
}

/** Write a key; resolves with the new store revision. */
export function setBellstate(key, value, opts) {
  getReplica();
  return window.bellstate.set(key, value, opts);
}

/** Atomic per-property merge; null deletes a field. Conflict-free. */
export function mergeBellstate(key, partial) {
  getReplica();
  return window.bellstate.merge(key, partial);
}

/** Server-side atomic increment — safe under concurrent writers. */
export function incrBellstate(key, by = 1) {
  getReplica();
  return window.bellstate.incr(key, by);
}

export function deleteBellstate(key) {
  getReplica();
  return window.bellstate.delete(key);
}

/** Signal that is true while the main process is connected to the daemon. */
export function bellstateConnected() {
  return getReplica().connected.asReadonly();
}

/** Signal of the store revision — changes on every write on the machine. */
export function bellstateRev() {
  return getReplica().rev.asReadonly();
}
