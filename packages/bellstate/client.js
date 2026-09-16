'use strict';

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { resolveDaemonPath } = require('./daemon-path');

const PROTOCOL_V = 1;
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200];
const MAX_CONNECT_ATTEMPTS = 12;
const OFFLINE_QUEUEABLE = new Set(['set', 'del', 'incr', 'mset', 'merge', 'clear']);
const OFFLINE_QUEUE_MAX = 1000;
/** Serialized values above this go through the chunked transfer path. */
const LARGE_THRESHOLD = 512 * 1024;
const CHUNK_RAW = 512 * 1024;

/** Compute the socket path the daemon uses for a namespace (mirrors bellstated). */
function socketPathFor(namespace) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\bellstate-${namespace}`;
  }
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, 'bellstate', `${namespace}.sock`);
}

// ---- fractional-index ordering (Figma-style) ------------------------------
// ASCII-ordered base-62 digits; generated keys never end in the lowest digit,
// so there is always room between any two generated keys.

const ORDER_DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A string strictly between `a` and `b` in lexicographic order.
 * Pass null for an open bound: orderBetween(null, x) → before x,
 * orderBetween(x, null) → after x, orderBetween(null, null) → first key.
 * Lets concurrent processes insert into ordered lists without renumbering.
 */
function orderBetween(a = null, b = null) {
  const A = a ?? '';
  const B = b ?? '';
  if (a != null && b != null && A >= B) {
    throw new Error(`bellstate: orderBetween requires a < b (got '${A}' >= '${B}')`);
  }
  let prefix = '';
  let upperOpen = b == null;
  for (let i = 0; ; i++) {
    const da = i < A.length ? ORDER_DIGITS.indexOf(A[i]) : 0;
    const db = upperOpen || i >= B.length ? ORDER_DIGITS.length : ORDER_DIGITS.indexOf(B[i]);
    if (db - da > 1) {
      return prefix + ORDER_DIGITS[Math.floor((da + db) / 2)];
    }
    // Equal or adjacent digits: copy the lower one and go deeper. Once we
    // commit to a digit below B's, the upper bound no longer constrains us.
    if (db - da === 1) upperOpen = true;
    prefix += ORDER_DIGITS[da];
  }
}

// ---- secure value envelope (AES-256-GCM) ----------------------------------

function defaultKeyFile() {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA || os.homedir()
        : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bellstate', 'secret.key');
}

function loadOrCreateKey(file) {
  try {
    const key = fs.readFileSync(file);
    if (key.length === 32) return key;
  } catch {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

function isSecureEnvelope(value) {
  return value != null && typeof value === 'object' && value.$sec === 1;
}

function conflictError(msg) {
  const err = new Error(`bellstate: ${msg.error}`);
  err.code = msg.error;
  if (msg.rev != null) err.rev = msg.rev;
  if ('value' in msg) err.value = msg.value;
  if (msg.large) err.large = true;
  return err;
}

/**
 * Client for the bellstated daemon.
 *
 * Keeps a local replica of the store (values + per-key revisions), updated by
 * daemon broadcasts, so reads are synchronous. Writes round-trip to the
 * daemon and can be conditional (`ifRev` compare-and-set). If the daemon
 * dies, the client respawns it, resyncs, and re-establishes its ephemeral
 * keys — pending and subsequent writes wait for the reconnect.
 *
 * Large values (serialized > 512 KB) are transparently chunked on write and
 * lazily fetched on read, so one big value never blocks small operations;
 * `get()` returns the last fully-synced value and a 'change' event fires
 * once the new payload has arrived.
 *
 * Events: 'change' ({key, value, deleted, expired, ephemeral, rev}),
 *         'mchange', 'clear', 'sync', 'disconnect', 'reconnect', 'error',
 *         'ephemeral-lost' (an ephemeral key could not be re-claimed after
 *         reconnect — e.g. a lock lost across a daemon restart)
 */
class BellstateClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.namespace = opts.namespace || 'default';
    this.socketPath = opts.socketPath || socketPathFor(this.namespace);
    this.rev = 0;
    this.daemonVersion = null;

    this._opts = {
      daemonPath: opts.daemonPath,
      spawnDaemon: opts.spawnDaemon !== false,
      autoRespawn: opts.autoRespawn !== false,
      requestTimeout: opts.requestTimeout || 5000,
      idleTimeout: opts.idleTimeout, // seconds; passed to the daemon on spawn
      dataFile: opts.dataFile, // persistence path; passed to the daemon on spawn
      offlineQueue: opts.offlineQueue !== false,
    };

    // Encrypted-at-rest values: {secure: true} uses a machine-local key file
    // (0600) shared by every bellstate client on this machine, so an app
    // suite can share tokens while snapshots/WAL/backups hold only ciphertext.
    // Pass {secure: {keyFile}} to scope the key to your own suite.
    if (opts.secure) {
      const keyFile =
        typeof opts.secure === 'object' && opts.secure.keyFile
          ? opts.secure.keyFile
          : defaultKeyFile();
      this._secureKey = loadOrCreateKey(keyFile);
    } else {
      this._secureKey = null;
    }
    this._secureKeys = new Set(); // keys currently holding secure envelopes
    this._undo = null; // enabled via enableUndo()
    this._offline = []; // queued writes while the daemon is unreachable

    this._clientId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this._cache = new Map(); // key -> {value, rev}
    this._ephemeral = new Map(); // key -> {value, ttl} — replayed on reconnect
    this._largeFetches = new Map(); // key -> Promise, dedupes background fetches
    this._socket = null;
    this._pending = new Map(); // id -> {resolve, reject, timer, chunks}
    this._nextId = 1;
    this._buffer = '';
    this._closed = false;
    this._reconnecting = false;
    this._resetReady();
  }

  // ---- reads (synchronous, from the local replica) ----------------------

  get(key) {
    return this._cache.get(key)?.value;
  }

  /** Revision at which a key last changed (0 if absent). CAS anchor. */
  getRev(key) {
    return this._cache.get(key)?.rev ?? 0;
  }

  has(key) {
    return this._cache.has(key);
  }

  keys(prefix = '') {
    const out = [];
    for (const k of this._cache.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }

  getAll() {
    const out = {};
    for (const [k, e] of this._cache) out[k] = e.value;
    return out;
  }

  /**
   * Like get(), but waits for any in-flight large-value download for the
   * key to finish first, so the result is never stale.
   */
  async fetch(key) {
    const entry = this._cache.get(key);
    if (entry?.pendingLarge) await this._fetchLarge(key);
    return this._cache.get(key)?.value;
  }

  // ---- writes ------------------------------------------------------------

  /**
   * Write a key. Resolves with the store revision once acknowledged.
   * Options: ifRev (compare-and-set; rejects with err.code === 'conflict'),
   * ttl (ms until auto-delete), ephemeral (key dies with this connection,
   * and is automatically re-established after reconnects).
   */
  async set(key, value, opts = {}) {
    let toWrite = value === undefined ? null : value;
    if (opts.secure) {
      this._requireSecure();
      toWrite = this._encrypt(toWrite);
    }
    const recording = this._undo && !opts.noRecord && !opts.ephemeral;
    const before = recording ? structuredClone(this.get(key)) : undefined;
    const wasSecure = this._secureKeys.has(key);

    const json = JSON.stringify(toWrite);
    const buf = Buffer.from(json, 'utf8');
    const rev =
      buf.length > LARGE_THRESHOLD
        ? await this._setChunked(key, buf, { ...opts, value: toWrite })
        : (
            await this._request({
              op: 'set',
              key,
              value: toWrite,
              ifRev: opts.ifRev,
              ttl: opts.ttl,
              ephemeral: opts.ephemeral || undefined,
            })
          ).rev;
    if (opts.ephemeral) {
      this._ephemeral.set(key, { value: toWrite, ttl: opts.ttl });
    }
    if (recording) {
      this._recordUndo({
        kind: 'set',
        key,
        before,
        after: structuredClone(value === undefined ? null : value),
        secure: !!opts.secure || wasSecure,
      });
    }
    return rev;
  }

  async _setChunked(key, buf, opts) {
    const begin = await this._request({
      op: 'bset',
      key,
      size: buf.length,
      ifRev: opts.ifRev,
      ttl: opts.ttl,
      ephemeral: opts.ephemeral || undefined,
    });
    const chunkOps = [];
    for (let off = 0; off < buf.length; off += CHUNK_RAW) {
      chunkOps.push(
        this._request({
          op: 'bchunk',
          token: begin.token,
          data: buf.subarray(off, off + CHUNK_RAW).toString('base64'),
        })
      );
    }
    await Promise.all(chunkOps);
    const res = await this._request({ op: 'bcommit', token: begin.token });
    return res.rev;
  }

  /**
   * Atomic read-modify-write. `fn(currentValue)` returns the next value;
   * retried (with the fresh value) if another process wrote concurrently.
   */
  async update(key, fn, { retries = 16 } = {}) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const entry = this._cache.get(key);
      const next = await fn(entry?.value);
      try {
        const rev = await this.set(key, next, { ifRev: entry?.rev ?? 0 });
        return { value: next, rev };
      } catch (err) {
        if (err.code !== 'conflict') throw err;
        if (err.large) {
          await this._fetchLarge(key);
        } else if (err.rev === 0) {
          this._cache.delete(key);
        } else {
          this._cache.set(key, { value: err.value, rev: err.rev });
        }
        // Jittered backoff so two tight update() loops can't livelock by
        // invalidating each other's in-flight writes in perfect lockstep.
        const cap = Math.min(50, 2 ** attempt);
        await new Promise((r) => setTimeout(r, Math.random() * cap));
      }
    }
    throw new Error(`bellstate: update('${key}') gave up after ${retries} conflicts`);
  }

  /**
   * Atomic per-property merge (Figma-style last-writer-wins per field):
   * fields in `partial` overwrite, `null` deletes a field, nested objects
   * merge recursively. Concurrent merges to different fields of the same
   * key never conflict — no CAS retries needed. Resolves with the revision.
   */
  async merge(key, partial, opts = {}) {
    if (this._secureKeys.has(key)) {
      throw new Error('bellstate: cannot merge a secure key; use set with {secure: true}');
    }
    const recording = this._undo && !opts.noRecord;
    const before = recording ? structuredClone(this.get(key)) : undefined;
    const res = await this._request({ op: 'merge', key, value: partial, ifRev: opts.ifRev });
    if (recording) {
      this._recordUndo({
        kind: 'merge',
        key,
        before,
        after: structuredClone(res.value),
        secure: false,
      });
    }
    return res.rev;
  }

  /** Server-side atomic increment. Resolves with the new value. */
  async incr(key, by = 1) {
    const res = await this._request({ op: 'incr', key, by });
    return res.value;
  }

  /** Atomically write several keys (and/or delete some) in one revision. */
  async mset(entries, { del } = {}) {
    const res = await this._request({ op: 'mset', entries, del });
    return res.rev;
  }

  async delete(key, opts = {}) {
    this._ephemeral.delete(key);
    const recording = this._undo && !opts.noRecord;
    const before = recording ? structuredClone(this.get(key)) : undefined;
    const wasSecure = this._secureKeys.has(key);
    const res = await this._request({ op: 'del', key });
    if (recording && res.existed) {
      this._recordUndo({ kind: 'del', key, before, after: undefined, secure: wasSecure });
    }
    return res.existed;
  }

  async clear() {
    this._ephemeral.clear();
    const res = await this._request({ op: 'clear' });
    return res.rev;
  }

  // ---- multiplayer undo/redo --------------------------------------------
  // Figma semantics: undo reverts YOUR operations only, as new operations —
  // it never touches what other users did. Each client has its own stacks,
  // so per-user undo across a shared board falls out naturally.

  enableUndo({ limit = 200 } = {}) {
    this._undo = { stack: [], redo: [], limit };
    return this;
  }

  _recordUndo(entry) {
    const u = this._undo;
    u.stack.push(entry);
    if (u.stack.length > u.limit) u.stack.shift();
    u.redo.length = 0;
  }

  get undoDepth() {
    return this._undo?.stack.length ?? 0;
  }

  get redoDepth() {
    return this._undo?.redo.length ?? 0;
  }

  /** Revert this client's most recent recorded mutation. False if empty. */
  async undo() {
    const u = this._undo;
    if (!u || !u.stack.length) return false;
    const entry = u.stack.pop();
    u.redo.push(entry);
    await this._applyUndoValue(entry.key, entry.before, entry.secure);
    return true;
  }

  /** Re-apply this client's most recently undone mutation. */
  async redo() {
    const u = this._undo;
    if (!u || !u.redo.length) return false;
    const entry = u.redo.pop();
    u.stack.push(entry);
    await this._applyUndoValue(entry.key, entry.after, entry.secure);
    return true;
  }

  async _applyUndoValue(key, value, secure) {
    if (value === undefined) {
      await this.delete(key, { noRecord: true });
    } else {
      await this.set(key, value, { noRecord: true, secure: secure || undefined });
    }
  }

  // ---- secure values ------------------------------------------------------

  _requireSecure() {
    if (!this._secureKey) {
      throw new Error('bellstate: secure values need connect({secure: true})');
    }
  }

  _encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._secureKey, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return {
      $sec: 1,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  /** Decrypt at ingestion so caches, events, and reads all see plaintext. */
  _ingest(key, value) {
    if (!isSecureEnvelope(value)) {
      this._secureKeys.delete(key);
      return value;
    }
    this._secureKeys.add(key);
    if (!this._secureKey) return value; // no key: callers see the envelope
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this._secureKey,
        Buffer.from(value.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(value.ct, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(pt.toString('utf8'));
    } catch {
      return value; // wrong key: leave the envelope intact
    }
  }

  // ---- coordination primitives ------------------------------------------

  /**
   * Try to claim a machine-global lock. Returns true if acquired. The lock
   * is ephemeral: it releases automatically when this client disconnects.
   */
  async acquire(key, value = true) {
    try {
      await this.set(key, value, { ifRev: 0, ephemeral: true });
      return true;
    } catch (err) {
      if (err.code === 'conflict') return false;
      throw err;
    }
  }

  async release(key) {
    return this.delete(key);
  }

  /**
   * Announce this process under `presence:<name>#<clientId>`. The entry
   * disappears automatically when this client disconnects. Returns the key.
   */
  async presence(name, meta = {}) {
    const key = `presence:${name}#${this._clientId}`;
    await this.set(key, { ...meta, pid: process.pid, since: Date.now() }, { ephemeral: true });
    return key;
  }

  /** Live presence entries, optionally filtered by name. */
  peers(name) {
    const prefix = name ? `presence:${name}#` : 'presence:';
    const out = [];
    for (const key of this.keys(prefix)) {
      const rest = key.slice('presence:'.length);
      const hash = rest.lastIndexOf('#');
      out.push({
        key,
        name: hash === -1 ? rest : rest.slice(0, hash),
        value: this.get(key),
      });
    }
    return out;
  }

  /**
   * Transient lane: fire-and-forget broadcast with no revision, no
   * persistence, and no ack — built for high-frequency data like cursors
   * and drag motion. Latency is one socket hop; a lost pulse costs nothing
   * because the next one is milliseconds behind. Silently dropped while
   * disconnected (transient data has no meaning after a gap anyway).
   */
  pulse(channel, value, opts = {}) {
    if (!this._socket) return;
    this._socket.write(
      JSON.stringify({ op: 'pulse', ch: channel, value, keep: opts.keep }) + '\n'
    );
  }

  /**
   * Recent history of a stream — pulses sent with {keep: N}. Lets a late
   * joiner backfill (e.g. a transcript overlay opened mid-meeting).
   * History is memory-only and bounded; it dies with the daemon, by design.
   */
  async history(channel, limit = 50) {
    const res = await this._request({ op: 'hist', ch: channel, limit });
    return res.values;
  }

  /**
   * Subscribe to pulses on an exact channel or 'prefix*' pattern.
   * Returns an unsubscribe function.
   */
  watchPulse(pattern, callback) {
    const matches = pattern.endsWith('*')
      ? (ch) => ch.startsWith(pattern.slice(0, -1))
      : (ch) => ch === pattern;
    const handler = (event) => {
      if (matches(event.ch)) callback(event);
    };
    this.on('pulse', handler);
    return () => this.removeListener('pulse', handler);
  }

  /**
   * Subscribe to changes for an exact key or a 'prefix*' pattern.
   * Returns an unsubscribe function.
   */
  watch(pattern, callback) {
    const matches = pattern.endsWith('*')
      ? (key) => key.startsWith(pattern.slice(0, -1))
      : (key) => key === pattern;
    const handler = (change) => {
      if (matches(change.key)) callback(change);
    };
    this.on('change', handler);
    return () => this.removeListener('change', handler);
  }

  // ---- daemon management --------------------------------------------------

  async ping() {
    return this._request({ op: 'ping' });
  }

  async stats() {
    return this._request({ op: 'stats' });
  }

  /** Ask the daemon to persist and exit. */
  async shutdownDaemon() {
    if (!this._socket) return;
    this._closed = true; // don't respawn after this
    try {
      await this._request({ op: 'shutdown' });
    } catch {
      // The daemon may exit before the response is read; that's fine.
    }
  }

  /** Disconnect this client. The daemon keeps running for other clients. */
  close() {
    this._closed = true;
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._rejectPending(new Error('bellstate: client closed'));
  }

  // ---- connection lifecycle --------------------------------------------

  async connect() {
    await this._connectWithRetry();
    return this;
  }

  _resetReady() {
    this._ready = new Promise((resolve) => {
      this._readyResolve = resolve;
    });
  }

  /** Writes waiting out a daemon outage. */
  get offlineQueueSize() {
    return this._offline.length;
  }

  _flushOffline() {
    const queued = this._offline;
    this._offline = [];
    for (const { payload, resolve, reject } of queued) {
      this._send(payload).then(resolve, reject);
    }
  }

  async _connectWithRetry() {
    let spawned = false;
    let lastError;
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this._dial();
        await this._handshake();
        this._readyResolve();
        this._flushOffline();
        return;
      } catch (err) {
        if (err.fatal) throw err; // e.g. protocol version mismatch
        lastError = err;
        if (this._closed) throw err;
        if (!spawned && this._opts.spawnDaemon) {
          this._spawnDaemon();
          spawned = true;
        }
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error(
      `bellstate: could not reach daemon at ${this.socketPath}: ${lastError?.message}`
    );
  }

  _dial() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const onError = (err) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        socket.setNoDelay?.(true);
        this._socket = socket;
        this._buffer = '';
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', () => {}); // 'close' handles teardown
        socket.on('close', () => this._onClose(socket));
        resolve();
      });
    });
  }

  async _handshake() {
    let hello;
    try {
      hello = await this._send({ op: 'hello', v: PROTOCOL_V });
    } catch (err) {
      if (String(err.message).includes('protocol version')) err.fatal = true;
      throw err;
    }
    this.daemonVersion = hello.version;
    await this._send({ op: 'sub' }); // full replication
    const snap = await this._send({ op: 'snapshot' });
    this._applySnapshot(snap);
    await this._replayEphemeral();
  }

  _applySnapshot(snap) {
    const prev = this._cache;
    const next = new Map();
    for (const [k, e] of Object.entries(snap.state || {})) {
      next.set(k, { value: this._ingest(k, e.v), rev: e.r });
    }
    for (const [k, meta] of Object.entries(snap.large || {})) {
      // Keep the previously synced payload (possibly stale) while the new
      // one downloads in the background; a 'change' fires when it lands.
      next.set(k, { value: prev.get(k)?.value, rev: meta.r, pendingLarge: true });
    }
    this._cache = next;
    this.rev = snap.rev || 0;
    this.emit('sync', { state: this.getAll(), rev: this.rev });
    for (const [k, e] of next) {
      if (e.pendingLarge) this._fetchLarge(k);
    }
  }

  async _replayEphemeral() {
    for (const [key, spec] of [...this._ephemeral]) {
      try {
        // ifRev 0 = only claim if free. Correct for locks (don't steal a
        // lock someone else took while we were gone) and harmless for
        // presence keys, whose names are unique to this client.
        await this._send({
          op: 'set',
          key,
          value: spec.value,
          ifRev: 0,
          ttl: spec.ttl,
          ephemeral: true,
        });
      } catch (err) {
        if (err.code === 'conflict') {
          this._ephemeral.delete(key);
          this.emit('ephemeral-lost', { key });
        }
      }
    }
  }

  _spawnDaemon() {
    const daemonPath = resolveDaemonPath(this._opts.daemonPath);
    const args = ['--namespace', this.namespace, '--socket', this.socketPath];
    if (this._opts.idleTimeout != null) {
      args.push('--idle-timeout', String(this._opts.idleTimeout));
    }
    if (this._opts.dataFile) {
      args.push('--data-file', this._opts.dataFile);
    }
    const child = spawn(daemonPath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => this.emit('error', err));
    child.unref();
  }

  _onClose(socket) {
    if (this._socket !== socket) return; // stale socket from a previous life
    this._socket = null;
    if (this._closed) return;

    this._resetReady();
    this.emit('disconnect');

    if (!this._opts.autoRespawn) {
      this._rejectPending(new Error('bellstate: daemon connection lost'));
      return;
    }
    if (this._reconnecting) return;
    this._reconnecting = true;

    // In-flight requests died with the socket; the daemon may not have seen
    // them, so we can't safely retry writes — fail them, but let *new*
    // requests queue on the ready promise until we're back.
    this._rejectPending(new Error('bellstate: daemon connection lost, reconnecting'));

    this._connectWithRetry()
      .then(() => {
        this._reconnecting = false;
        this.emit('reconnect', { rev: this.rev });
      })
      .catch((err) => {
        this._reconnecting = false;
        this.emit('error', err);
      });
  }

  // ---- large-value background fetch --------------------------------------

  _fetchLarge(key) {
    const existing = this._largeFetches.get(key);
    if (existing) return existing;
    const task = this._fetchLargeLoop(key).finally(() => this._largeFetches.delete(key));
    this._largeFetches.set(key, task);
    return task;
  }

  async _fetchLargeLoop(key) {
    for (let attempt = 0; attempt < 8; attempt++) {
      let res;
      try {
        res = await this._request({ op: 'bget', key });
      } catch {
        return; // disconnected; the post-reconnect snapshot re-triggers us
      }
      const entry = this._cache.get(key);
      if (res.rev === 0) {
        // Deleted while we were fetching; the delete event handles the cache.
        return;
      }
      if (entry && entry.rev > res.rev) {
        continue; // a newer write landed mid-download; fetch again
      }
      const value = this._ingest(key, 'text' in res ? JSON.parse(res.text) : res.value);
      this._cache.set(key, { value, rev: res.rev });
      this.emit('change', { key, value, deleted: false, rev: res.rev, large: true });
      return;
    }
  }

  // ---- protocol ---------------------------------------------------------

  _onData(chunk) {
    this._buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.ev) {
        this._onEvent(msg);
        continue;
      }
      if (msg.id == null || !this._pending.has(msg.id)) continue;
      const pending = this._pending.get(msg.id);

      if (msg.more) {
        // Chunk frame of a bget stream: accumulate, keep the request alive.
        pending.chunks ??= [];
        pending.chunks.push(Buffer.from(msg.data, 'base64'));
        clearTimeout(pending.timer);
        pending.timer = setTimeout(pending.onTimeout, this._opts.requestTimeout);
        continue;
      }

      this._pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (!msg.ok) {
        if (msg.rev != null && isSecureEnvelope(msg.value)) {
          msg = { ...msg, value: this._ingest(pending.key ?? '', msg.value) };
        }
        pending.reject(conflictError(msg));
      } else if (pending.chunks) {
        pending.resolve({ ...msg, text: Buffer.concat(pending.chunks).toString('utf8') });
      } else {
        pending.resolve(msg);
      }
    }
  }

  _onEvent(msg) {
    if (msg.ev === 'change') {
      this.rev = Math.max(this.rev, msg.rev);
      if (msg.deleted) {
        this._cache.delete(msg.key);
        this._secureKeys.delete(msg.key);
        if (msg.eph || msg.expired) this._ephemeral.delete(msg.key);
        this.emit('change', {
          key: msg.key,
          value: undefined,
          deleted: true,
          expired: !!msg.expired,
          ephemeral: !!msg.eph,
          rev: msg.rev,
        });
      } else if (msg.large) {
        // Metadata-only event for a big value: keep serving the old payload,
        // download the new one, emit 'change' when it's fully here.
        const prev = this._cache.get(msg.key);
        this._cache.set(msg.key, {
          value: prev?.value,
          rev: msg.rev,
          pendingLarge: true,
        });
        this._fetchLarge(msg.key);
      } else {
        const value = this._ingest(msg.key, msg.value);
        this._cache.set(msg.key, { value, rev: msg.rev });
        this.emit('change', {
          key: msg.key,
          value,
          deleted: false,
          ephemeral: !!msg.eph,
          rev: msg.rev,
        });
      }
    } else if (msg.ev === 'mchange') {
      this.rev = Math.max(this.rev, msg.rev);
      const ingested = {};
      for (const [k, v] of Object.entries(msg.entries || {})) {
        ingested[k] = this._ingest(k, v);
        this._cache.set(k, { value: ingested[k], rev: msg.rev });
      }
      for (const k of msg.del || []) {
        this._cache.delete(k);
        this._secureKeys.delete(k);
      }
      for (const [k, v] of Object.entries(ingested)) {
        this.emit('change', { key: k, value: v, deleted: false, rev: msg.rev });
      }
      for (const k of msg.del || []) {
        this.emit('change', { key: k, value: undefined, deleted: true, rev: msg.rev });
      }
      this.emit('mchange', { entries: msg.entries, del: msg.del, rev: msg.rev });
    } else if (msg.ev === 'clear') {
      this.rev = Math.max(this.rev, msg.rev);
      this._cache.clear();
      this.emit('clear', { rev: msg.rev });
    } else if (msg.ev === 'pulse') {
      this.emit('pulse', { ch: msg.ch, value: msg.value });
    }
  }

  /** Queue a request; waits for the connection to be ready (incl. reconnects). */
  async _request(payload) {
    if (this._closed && payload.op !== 'shutdown') {
      throw new Error('bellstate: client closed');
    }
    // Offline write queue: unconditional mutations issued while the daemon
    // is unreachable are held (bounded) and replayed after resync, instead
    // of timing out. CAS writes are excluded — their premise may be stale.
    if (
      !this._socket &&
      this._opts.offlineQueue &&
      this._opts.autoRespawn &&
      OFFLINE_QUEUEABLE.has(payload.op) &&
      payload.ifRev === undefined
    ) {
      if (this._offline.length >= OFFLINE_QUEUE_MAX) {
        throw new Error('bellstate: offline queue full');
      }
      return new Promise((resolve, reject) => {
        this._offline.push({ payload, resolve, reject });
      });
    }
    // Wait (bounded) for the connection to be ready, then send. _send has
    // its own per-request timeout, so only the ready-wait is raced here.
    const timeoutMs = this._opts.requestTimeout;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`bellstate: ${payload.op} timed out waiting for connection`)),
        timeoutMs
      );
    });
    try {
      await Promise.race([this._ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return this._send(payload);
  }

  _send(payload) {
    return new Promise((resolve, reject) => {
      if (!this._socket) {
        reject(new Error('bellstate: not connected'));
        return;
      }
      const id = this._nextId++;
      const onTimeout = () => {
        this._pending.delete(id);
        reject(new Error(`bellstate: ${payload.op} timed out`));
      };
      const pending = {
        resolve,
        reject,
        onTimeout,
        timer: setTimeout(onTimeout, this._opts.requestTimeout),
        chunks: null,
        key: payload.key,
      };
      this._pending.set(id, pending);
      this._socket.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  _rejectPending(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }
}

/** Connect to the store for a namespace, spawning the daemon if needed. */
async function connect(opts = {}) {
  const client = new BellstateClient(opts);
  return client.connect();
}

module.exports = { BellstateClient, connect, socketPathFor, orderBetween, PROTOCOL_V };
