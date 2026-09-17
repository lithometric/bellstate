// Svelte stores over the window.bellstate renderer API (exposed by
// 'bellstate/preload'). Implements the plain store contract — no dependency
// on svelte itself — so `$store` auto-subscription and `bind:` just work.
// A single renderer-side replica is shared by every store instance.

let replica = null;

function getReplica() {
  if (replica) return replica;
  if (typeof window === 'undefined' || !window.bellstate) {
    throw new Error(
      'bellstate-svelte: window.bellstate is missing. Call exposeBellstate() ' +
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
    has: (key) => state.has(key),
    isConnected: () => connected,
    getRev: () => rev,
  };
  return replica;
}

/** Adapt the replica to the svelte store contract for one derived value. */
function derivedStore(read) {
  return {
    subscribe(run) {
      const store = getReplica();
      let last = read(store);
      run(last);
      return store.subscribe(() => {
        const next = read(store);
        if (!Object.is(next, last)) {
          last = next;
          run(next);
        }
      });
    },
  };
}

/**
 * Live machine-global value as a writable svelte store:
 * `const todos = bellstateStore('todos', [])` → `$todos`, `bind:value`.
 * set/update write through the daemon (all processes see them).
 */
export function bellstateStore(key, initialValue) {
  const base = derivedStore((s) => (s.has(key) ? s.get(key) : initialValue));
  return {
    subscribe: base.subscribe,
    set: (next) => window.bellstate.set(key, next),
    update: (fn) => {
      const s = getReplica();
      const current = s.has(key) ? s.get(key) : initialValue;
      return window.bellstate.set(key, fn(current));
    },
  };
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

/** Store that is true while the main process is connected to the daemon. */
export function bellstateConnected() {
  return derivedStore((s) => s.isConnected());
}

/** Store of the store revision — changes on every write on the machine. */
export function bellstateRev() {
  return derivedStore((s) => s.getRev());
}
