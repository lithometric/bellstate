# Code Review — 2026-09-16

Scope: the core library (`daemon/src/main.rs`, `packages/bellstate/*`,
`packages/bellstate-react/*`). Method: six independent finder passes
(line-scan × 2, wire-protocol contract audit, bridge/CLI/types tracer,
cleanup sweep, efficiency sweep), then adversarial verification of every
candidate. All findings below were **CONFIRMED** with quoted code unless
noted. Status column tracks fixes.

The pattern behind almost every bug: the happy paths are covered by the
25-step e2e suite, but the **intersections of features** — secure×undo,
ephemeral×WAL, offline×reconnect, TTL×incr — are where the defects live,
because no test crosses them. Fixes should land with e2e steps for exactly
those intersections.

## Ranked findings (most severe first)

| # | File · line | Finding | Status |
|---|---|---|---|
| 1 | `packages/bellstate/client.js:610` | **Offline queue loses writes on mid-flush disconnect.** `_flushOffline()` empties the queue and fires `_send()` per entry; if the fresh socket drops, `_rejectPending` rejects them and nothing re-queues — durably-queued writes are gone despite `offlineQueue: true`. | open |
| 2 | `daemon/src/main.rs:344` | **Ephemeral set over a persistent key resurrects the stale value after a crash.** Ephemeral writes/deletes skip the WAL, so `set k=1` (persisted) → `set k=2 ephemeral` → owner disconnect → SIGKILL+restart replays the old `k=1`, contradicting what every client observed. | open |
| 3 | `daemon/src/main.rs:869` (incr), `:827` (merge) | **`incr` and `merge` silently clear a key's TTL.** The handlers pass the request's absent `ttl` into `apply_set`, which overwrites `expires_at_ms` with `None`. A rate-limit counter created with `{ttl: 60000}` becomes permanent on its first `incr`. | open |
| 4 | `packages/bellstate/client.js:706` | **Large ephemeral replay → infinite reconnect loop.** `_replayEphemeral` sends the full cached value as one inline `set` frame, bypassing the chunked path. A >~750 KB ephemeral value exceeds `max_frame`; the daemon rejects and closes, the client reconnects and replays again, forever. | open |
| 5 | `packages/bellstate/client.js:589` | **`close()` leaves offline-queued promises hanging forever.** It rejects `_pending` but never drains `_offline`; with `_closed = true` no reconnect will ever flush them. An awaited offline `set()` never settles. | open |
| 6 | `packages/bellstate/client.js:906` | **`_secureKeys` never pruned on `clear` (or for keys absent from a reconnect snapshot).** A stale entry makes `merge()` throw "cannot merge a secure key" on a now-plain key, and makes a later plain `set()` silently re-encrypt (`wasSecure` stale-true). | open |
| 7 | `daemon/src/main.rs:1192` | **Unbounded `read_line` before the frame check — local DoS.** A client streaming bytes with no newline grows the buffer without limit; the `max_frame` guard runs only after the whole line is in memory. Any local process can OOM the machine-global daemon. | open |
| 8 | `daemon/src/main.rs:294` | **Slow-client eviction never closes the read half or decrements `clients`.** Dropping the `ConnHandle` stops the writer but sends no FIN (read half still held by the read loop); the loop blocks forever, `clients` stays inflated, `stats` lies, and `--idle-timeout` never fires. | open |

## Confirmed but below the severity cut

Fix in the same pass — all verified real:

### Correctness
- `daemon incr`: unchecked `i64` addition — `i64::MAX + 1` panics (debug) or wraps (release), and the wrapped value is persisted to the WAL.
- `client` undo entries store one `secure` flag for both directions: redo of a *plain* overwrite of a previously-secure key re-applies it **encrypted**, diverging from the original op.
- `client.js:903`: `mchange` emits the raw `msg.entries` (ciphertext envelopes) instead of the decrypted `ingested` map built two lines above.
- `daemon bset` CAS fast-fail hardcodes `conflict{value: null, large: true}` even when the current value is small — `update()` does a pointless `bget` round-trip and direct callers get lied to.
- Daemon error frames without an `id` ("invalid json", "frame too large") are dropped by the client's dispatch, so the offending request hangs to its 5s timeout with a generic message.
- Pending `bset` blobs are unbounded per connection (no token-count or aggregate-bytes cap) — memory exhaustion from one live connection.
- WAL compaction writes `data_file.with_extension("json.tmp")` outside the lock while `cleanup_and_exit` can write the **same** tmp path concurrently — racing renames can land a half-written or stale snapshot.
- Idle-exit race: `clients` increments inside the spawned `serve_conn`, not at `accept()`; a microsecond window lets `idle_loop` kill the daemon under a mid-handshake client.
- Large-value change events drop the `eph` flag, so big ephemeral keys are reported to subscribers as durable.

### Bridge / packaging
- `bellstate/main.js` forwards six store events but not `ephemeral-lost` (a renderer holding a lock can never learn it lost it) nor `mchange`.
- The documented startup `sync` renderer event is unobservable: it fires during `initBellstate()` before any window (or even the bridge listener) exists. `bellstate-react` dodges this only by calling `snapshot()` itself.
- `bellstate-react/index.d.ts` imports types from `bellstate`, but its `package.json` declares no dependency/peerDependency on it — TS consumers installing only the hooks package get unresolvable types.
- `main.d.ts` `CHANNEL` type declares 5 of the 10 runtime keys (missing merge, incr, history, undo, redo).
- Renderer `merge` cannot pass `ifRev` (preload drops opts), so CAS-merge is silently unavailable from renderers.

### Performance (hot paths)
- `daemon emit()` clones the event `String` once per matching subscriber — the fan-out core should pass `Arc<str>`; at claimed rates this is millions of avoidable allocations/sec.
- Both sides serialize every value **twice** per durable write (size probe, then wire frame); daemon `apply_set` also deep-clones the value into the event. Roughly halves achievable write throughput on medium values.
- Undo recording `structuredClone`s full before/after values — a 200-entry stack of 2 MB values pins ~800 MB and blocks the event loop per write. Skip or store serialized form; cap recorded value size.
- A client re-downloads the large value it just uploaded (its own metadata change event triggers `_fetchLarge`; no self-origin suppression).
- `snapshot` deep-clones and serializes the entire store **under the global lock** — a reconnect storm serializes all clients behind O(store-bytes) work.
- `mset` serializes each entry twice and (unlike `set`) can neither carry large values nor cache their serialization — drift from the shared set path.

### Cleanup
- The `'prefix*'` pattern matcher is implemented three times (client `watch`, client `watchPulse`, preload) plus once in the daemon — extract one helper per side.
- The serialize→size→`Arc` cache block appears four times in the daemon (`set`, `merge`, `bcommit`, `insert_loaded`) — extract `Entry::from_value`.
- `clients` counter is redundant with `conns.len()` (and already drifts — finding #8).
- `bget` chunk frames carry a `seq` the client never reads — drop it or honor it.
- `daemonVersion` is assigned but never read internally (it is public API via d.ts — keep, but intentionally).

## Reproduction notes

Each ranked finding names its trigger inline. The fastest confirmations:

```bash
# 3 — TTL cleared by incr (observable in ~2s):
npx bellstate set counter 0 --ns t; # then via API: set with ttl, incr, watch it never expire

# 7 — unbounded frame (DON'T run against a daemon you care about):
# node -e 'const n=require("net").connect(sock); setInterval(()=>n.write("x".repeat(1e6)),1)'
```
