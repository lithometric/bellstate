'use strict';

// React hooks over the window.bellstate renderer API (exposed by
// 'bellstate/preload'). A single renderer-side replica is built from one
// snapshot + one onChange subscription, shared by every hook instance.

const { useCallback, useSyncExternalStore } = require('react');

let replica = null;

function getReplica() {
  if (replica) return replica;
  if (typeof window === 'undefined' || !window.bellstate) {
    throw new Error(
      'bellstate-react: window.bellstate is missing. Call exposeBellstate() ' +
        "from your preload script (require('bellstate/preload')) and create " +
        'the window with sandbox: false.'
    );
  }

  const state = new Map();
  const listeners = new Set();
  let connected = false;
  let rev = 0;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  window.bellstate.onChange((payload) => {
    if (payload.type === 'change') {
      rev = payload.rev;
      if (payload.deleted) state.delete(payload.key);
      else state.set(payload.key, payload.value);
    } else if (payload.type === 'sync') {
      rev = payload.rev;
      state.clear();
      for (const [k, v] of Object.entries(payload.state)) state.set(k, v);
      connected = true;
    } else if (payload.type === 'clear') {
      rev = payload.rev;
      state.clear();
    } else if (payload.type === 'disconnect') {
      connected = false;
    } else if (payload.type === 'reconnect') {
      connected = true;
    }
    emit();
  });

  window.bellstate.snapshot().then((snap) => {
    rev = snap.rev;
    for (const [k, v] of Object.entries(snap.state)) {
      if (!state.has(k)) state.set(k, v);
    }
    connected = true;
    emit();
  });

  replica = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (key) => state.get(key),
    isConnected: () => connected,
    getRev: () => rev,
  };
  return replica;
}

/**
 * Live machine-global value: `const [todos, setTodos] = useBellstate('todos', [])`.
 * Re-renders when any process on the machine writes the key.
 */
function useBellstate(key, initialValue) {
  const store = getReplica();
  const value = useSyncExternalStore(store.subscribe, () => store.get(key));
  const set = useCallback((next) => window.bellstate.set(key, next), [key]);
  return [value === undefined ? initialValue : value, set];
}

/** Server-side atomic increment bound to a key. */
function useBellstateIncr(key) {
  return useCallback((by = 1) => window.bellstate.incr(key, by), [key]);
}

/** True while the main process is connected to the daemon. */
function useBellstateStatus() {
  const store = getReplica();
  return useSyncExternalStore(store.subscribe, store.isConnected);
}

/** The store revision — changes on every write anywhere on the machine. */
function useBellstateRev() {
  const store = getReplica();
  return useSyncExternalStore(store.subscribe, store.getRev);
}

module.exports = {
  useBellstate,
  useBellstateIncr,
  useBellstateStatus,
  useBellstateRev,
};
