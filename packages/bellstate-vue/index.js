// Vue composables over the window.bellstate renderer API (exposed by
// 'bellstate/preload'). A single renderer-side replica is built from one
// snapshot + one onChange subscription, shared by every composable.

import { shallowRef, computed, readonly } from 'vue';

let replica = null;

function getReplica() {
  if (replica) return replica;
  if (typeof window === 'undefined' || !window.bellstate) {
    throw new Error(
      'bellstate-vue: window.bellstate is missing. Call exposeBellstate() ' +
        "from your preload script (require('bellstate/preload')) and create " +
        'the window with sandbox: false.'
    );
  }

  const state = new Map();
  // Bumped on every store event; per-key computeds re-read the map, so only
  // consumers whose key actually changed see a new value.
  const version = shallowRef(0);
  const connected = shallowRef(false);
  const rev = shallowRef(0);

  window.bellstate.onChange((payload) => {
    if (payload.type === 'change') {
      rev.value = payload.rev;
      if (payload.deleted) state.delete(payload.key);
      else state.set(payload.key, payload.value);
    } else if (payload.type === 'sync') {
      rev.value = payload.rev;
      state.clear();
      for (const [k, v] of Object.entries(payload.state)) state.set(k, v);
      connected.value = true;
    } else if (payload.type === 'clear') {
      rev.value = payload.rev;
      state.clear();
    } else if (payload.type === 'disconnect') {
      connected.value = false;
    } else if (payload.type === 'reconnect') {
      connected.value = true;
    }
    version.value++;
  });

  window.bellstate.snapshot().then((snap) => {
    rev.value = snap.rev;
    for (const [k, v] of Object.entries(snap.state)) {
      if (!state.has(k)) state.set(k, v);
    }
    connected.value = true;
    version.value++;
  });

  replica = { state, version, connected, rev };
  return replica;
}

/**
 * Live machine-global value as a writable computed ref — works with
 * v-model. Reading tracks the key; assigning writes through the daemon
 * (fire-and-forget from the ref; use setBellstate() to await the rev).
 */
export function useBellstate(key, initialValue) {
  const { state, version } = getReplica();
  return computed({
    get() {
      version.value;
      return state.has(key) ? state.get(key) : initialValue;
    },
    set(next) {
      window.bellstate.set(key, next);
    },
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
export function useBellstateIncr(key) {
  getReplica();
  return (by = 1) => window.bellstate.incr(key, by);
}

/** Read-only ref that is true while the main process is connected. */
export function useBellstateStatus() {
  return readonly(getReplica().connected);
}

/** Read-only ref of the store revision — changes on every write. */
export function useBellstateRev() {
  return readonly(getReplica().rev);
}
