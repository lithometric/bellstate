# bellstate

**Machine-global state for Electron and Node processes.** One store, every process, one source of truth — backed by a small Rust daemon.

Separate Electron apps (or any Node processes, or your shell) on the same machine read and write the same live store. Changes propagate to every subscriber in milliseconds. Writes can be atomic (`incr`, `update`, `mset`) so concurrent processes never lose updates. Kill the daemon and the first client that notices respawns it; state survives because every mutation hits a write-ahead log.

```
  Electron App A          Electron App B          npx bellstate watch
  ┌────────────┐          ┌────────────┐          ┌────────────┐
  │  renderer  │          │  renderer  │          │            │
  │     ↕ IPC  │          │     ↕ IPC  │          │  CLI       │
  │   main ────┼──┐    ┌──┼─── main    │       ┌──┼──          │
  └────────────┘  │    │  └────────────┘       │  └────────────┘
                  ▼    ▼                       ▼
              ┌─────────────────────────────────────┐
              │       bellstated  (Rust daemon)     │
              │  unix socket / named pipe · NDJSON  │
              │  per-key revisions · CAS · pub/sub  │
              │  ephemeral keys · TTL · chunked I/O │
              └─────────────────────────────────────┘
                                │
                     WAL + snapshot on disk
```

## Why

Electron gives you IPC *inside* one app. It gives you nothing *between* apps. If you ship two apps (or an app + a CLI + a background helper) that need shared settings, session state, or coordination, you end up hand-rolling lock files, polling JSON on disk, or running a local HTTP server. bellstate replaces all of that with one primitive: a machine-global key/value store with subscriptions, atomic writes, and process presence.

- **Synchronous reads** — each client keeps a local replica, updated by daemon broadcasts. `store.get(key)` never blocks.
- **No lost updates** — per-key revisions + compare-and-set. `update(key, fn)` retries automatically; `incr` is atomic in the daemon; `mset` writes several keys in one revision.
- **Crash-safe** — every mutation is appended to a write-ahead log (compacted into snapshots), so even `kill -9` loses at most a few milliseconds. Clients auto-respawn a dead daemon, resync, re-claim their ephemeral keys, and queued writes flush after reconnect.
- **Knows who's running** — ephemeral keys die with their connection: presence (`which of my apps are alive?`) and machine-global locks (`acquire`) fall out for free. TTL keys expire on their own.
- **Big values stay instant** — values over 512 KB are chunked on the wire, so an 8 MB write never blocks a 20-byte one, and are replicated lazily: subscribers get a metadata event immediately and the payload streams in the background.
- **Namespaced** — every namespace is its own socket, daemon, and state file.
- **Zero npm dependencies** — the client is plain Node. The daemon is a single static Rust binary.

## Quickstart (Electron)

```bash
npm install bellstate
```

**Main process:**

```js
const { app } = require('electron');
const { initBellstate } = require('bellstate/main');

app.whenReady().then(async () => {
  // Connects to the daemon (spawning it if needed) and bridges the store
  // to every renderer over IPC.
  const store = await initBellstate({ namespace: 'my-suite' });

  store.get('user');                       // sync read from the replica
  await store.set('user', { id: 42 });     // acknowledged write
  await store.incr('launches');            // atomic, cross-process
  await store.update('todos', (t = []) => [...t, 'ship it']); // CAS + retry
  await store.presence('main-app');        // visible to every process, auto-cleans
  store.watch('settings:*', ({ key, value }) => { /* live */ });
});
```

**Preload:**

```js
const { exposeBellstate } = require('bellstate/preload');
exposeBellstate(); // window.bellstate in the renderer
```

> Requiring an npm package from a preload needs `sandbox: false` in the
> window's `webPreferences` (context isolation stays on — that's the real
> boundary). Alternatively, bundle your preload and keep the sandbox.

**Renderer:**

```js
const { state, rev } = await window.bellstate.snapshot();
await window.bellstate.set('theme', 'dark');
await window.bellstate.incr('counter');           // safe under concurrent clicks
window.bellstate.watch('theme', ({ value }) => applyTheme(value));
```

**React renderer** (optional):

```bash
npm install bellstate-react
```

```jsx
import { useBellstate, useBellstateIncr, useBellstateStatus } from 'bellstate-react';

function Counter() {
  const [count] = useBellstate('counter', 0);   // re-renders on writes from ANY process
  const incr = useBellstateIncr('counter');
  const connected = useBellstateStatus();
  return <button onClick={() => incr()}>{count}{connected ? '' : ' (offline)'}</button>;
}
```

## Quickstart (plain Node)

```js
const { connect } = require('bellstate');

const store = await connect({ namespace: 'my-suite' });
await store.set('jobs:pending', 3);
console.log(store.get('jobs:pending'));
store.on('change', ({ key, value, rev }) => console.log(key, value, rev));
```

## CLI

The shell is just another client:

```bash
npx bellstate set theme dark
npx bellstate get user --ns my-suite
npx bellstate incr counter
npx bellstate watch 'presence:*'      # live event stream, Ctrl+C to stop
npx bellstate dump
npx bellstate stats
npx bellstate shutdown
```

## Coordination between processes

```js
// Presence: who's running right now?
await store.presence('editor', { version: app.getVersion() });
store.peers();            // → [{ name: 'editor', value: {...} }, ...]
store.watch('presence:*', () => refreshPeerList());

// Machine-global lock (auto-released if the holder dies):
if (await store.acquire('lock:migration')) {
  await runMigration();
  await store.release('lock:migration');
}

// Self-cleaning values:
await store.set('toast', 'Saved!', { ttl: 5000 });          // expires in 5s
await store.set('session', token, { ephemeral: true });      // dies with this process
```

Ephemeral keys are re-claimed automatically after a daemon restart; if re-claiming fails (someone else took the lock meanwhile) the client emits `'ephemeral-lost'`.

## The transient lane, streams, and everything else

```js
// Pulse lane: fire-and-forget fan-out — no revision, no WAL, no ack.
// ~350k msgs/sec, ~0.05ms median latency. For cursors, drag motion, meters.
store.pulse('cursor:me', { x, y });
store.watchPulse('cursor:*', ({ ch, value }) => {});

// Streams: pulses with bounded in-memory history — late joiners backfill.
store.pulse('transcript', { text }, { keep: 100 });
const recent = await store.history('transcript');

// Per-user multiplayer undo (reverts YOUR ops only, as new ops):
store.enableUndo();
await store.undo();  await store.redo();

// Encrypted at rest (AES-256-GCM; ciphertext on disk and to key-less clients):
const store = await connect({ secure: true }); // or {secure: {keyFile}}
await store.set('session', token, { secure: true });

// Fractional-index ordering — concurrent list inserts without renumbering:
const { orderBetween } = require('bellstate');
item.pos = orderBetween(prev.pos, next.pos);

// Offline queue (on by default): unconditional writes issued while the
// daemon is unreachable are held and replayed after resync.
store.offlineQueueSize;
```

## API

### `connect(options) → Promise<BellstateClient>`

| option | default | |
|---|---|---|
| `namespace` | `'default'` | store identity; one daemon + socket + state file per namespace |
| `socketPath` | derived | unix socket path / named pipe name override |
| `daemonPath` | auto-resolved | explicit path to `bellstated` |
| `spawnDaemon` | `true` | spawn the daemon if none is running |
| `autoRespawn` | `true` | respawn + resync if the daemon dies |
| `idleTimeout` | never | seconds after the last client disconnects before the daemon exits |
| `dataFile` | platform data dir | persistence path override |
| `requestTimeout` | `5000` | ms before a request fails |

### Reads (synchronous, from the local replica)

`get(key)` · `getRev(key)` · `has(key)` · `keys(prefix?)` · `getAll()` · `peers(name?)` · `await fetch(key)` (waits for any in-flight large-value download)

### Writes

- `await set(key, value, { ifRev?, ttl?, ephemeral? })` — `ifRev` is compare-and-set (0 = only-if-absent); rejects with `err.code === 'conflict'` carrying the current `rev`/`value`
- `await merge(key, partial)` — atomic per-property merge (Figma-style LWW per field): fields overwrite, `null` deletes a field, nested objects merge; concurrent merges to different fields never conflict
- `await update(key, fn)` — atomic read-modify-write, auto-retried with jittered backoff
- `await incr(key, by?)` — server-side atomic increment
- `await mset(entries, { del? })` — several writes/deletes in one revision
- `await delete(key)` · `await clear()`

### Coordination

`await acquire(key, value?)` · `await release(key)` · `await presence(name, meta?)` · `watch(pattern, cb)` (exact key or `'prefix*'`)

### Daemon

`await ping()` · `await stats()` · `await shutdownDaemon()` · `close()` · `rev` · `daemonVersion`

### Events

`change` · `mchange` · `clear` · `sync` · `disconnect` · `reconnect` · `ephemeral-lost` · `error`

### Electron helpers

- `bellstate/main` → `initBellstate(options)` — connect + IPC-bridge to all windows; returns the client
- `bellstate/preload` → `exposeBellstate(globalName?)` — renderer API: `snapshot`, `get`, `set`, `delete`, `incr`, `onChange`, `watch`
- `bellstate-react` → `useBellstate(key, initial?)`, `useBellstateIncr(key)`, `useBellstateStatus()`, `useBellstateRev()`

## The daemon

`bellstated` is a single async Rust binary (tokio). It listens on a Unix domain socket (`\\.\pipe\bellstate-<ns>` on Windows), speaks newline-delimited JSON (protocol v1, negotiated at `hello`), and:

- assigns a monotonically increasing **revision** to every mutation and remembers each key's last-modified revision (the compare-and-set anchor)
- **broadcasts** every change to matching subscribers; values over 512 KB broadcast as metadata and stream lazily via chunked reads
- appends every mutation to a **write-ahead log**, compacted into a snapshot at 4 MB (`--wal-max-mb`), with optional `--fsync` durability
- deletes **ephemeral** keys when their connection closes and **TTL** keys on a 500 ms sweep
- enforces a **max value size** (64 MB, `--max-value-mb`) and evicts clients whose event queues back up, so one bad consumer can't balloon the daemon
- detects stale sockets, refuses to double-run per namespace, exits when idle if asked (`--idle-timeout`)

You never start it by hand — the first client spawns it, detached. Protocol, if you want to speak it from other languages:

| request | response |
|---|---|
| `{"id":1,"op":"hello","v":1}` | `{"id":1,"ok":true,"v":1,"rev":7,"version":"0.1.0"}` |
| `{"id":2,"op":"set","key":"k","value":…,"ifRev":7}` | `{"id":2,"ok":true,"rev":8}` or `{"ok":false,"error":"conflict","rev":9,"value":…}` |
| `{"id":3,"op":"incr","key":"n","by":1}` | `{"id":3,"ok":true,"value":5,"rev":10}` |
| `{"id":4,"op":"sub","match":["user:*"]}` | then events: `{"ev":"change","key":"user:a","value":…,"rev":11}` |
| also | `get`, `snapshot`, `keys`, `del`, `mset`, `clear`, `unsub`, `ping`, `stats`, `shutdown`, and `bset`/`bchunk`/`bcommit`/`bget` for chunked large values |

Options on `set`: `ttl` (ms), `ephemeral` (bool). Deletion events carry `expired`/`eph` flags.

## Repo layout

```
daemon/               bellstated (Rust)
packages/bellstate/   the npm package (client + Electron helpers + CLI + .d.ts)
packages/bellstate-react/  React hooks
examples/electron-app/  MultiBoard — Figma-style multiplayer canvas exercising every feature
examples/roy-app/     TypeScript Electron example (shared todo list)
test/e2e/             25-step failover/concurrency/durability suite
scripts/              daemon bundling + platform-package generation
```

The examples are **standalone apps, not workspace members**: each one installs
bellstate from a packed tarball, exactly the way a real consumer runs
`npm install bellstate`. To work on one:

```bash
cd packages/bellstate && npm pack     # refresh the tarball after library changes
cd ../../examples/electron-app
npm install
npm start                             # + `npm run start2` for a second user
```

## Development

The core library has zero npm dependencies — the daemon build and the test
suite are all you need:

```bash
npm test        # cargo-builds the daemon, runs the 25-step e2e suite
```

The e2e suite is the contract: cross-process reads, CAS under contention (2×30 concurrent `update()`s, zero lost), 2×100 concurrent `incr`s → exactly 200, mset atomicity, pattern watch, an 8 MB chunked value that doesn't block small writes, ephemeral/TTL/lock semantics, SIGKILL → WAL recovery with every key intact, and lock re-claim after restart.

## Publishing

The `Publish to npm` workflow (manual trigger; needs an `NPM_TOKEN` secret) builds `bellstated` for macOS x64/arm64, Linux x64/arm64, and Windows x64, publishes each as a `bellstate-<platform>-<arch>` package, injects them as `optionalDependencies`, and publishes `bellstate` + `bellstate-react` — so `npm install bellstate` ships the right daemon binary everywhere, esbuild-style. Windows support is wired (named pipes, CI-tested) but younger than macOS/Linux.

## Roadmap

- Change history / time-travel debugging on top of the WAL
- Optional MessagePack framing for high-throughput workloads
- Encryption at rest

## License

MIT
