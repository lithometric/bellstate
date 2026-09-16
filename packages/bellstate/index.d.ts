import { EventEmitter } from 'node:events';

export declare const PROTOCOL_V: number;

export interface ConnectOptions {
  /** Store identity; one daemon + socket + state file per namespace. Default 'default'. */
  namespace?: string;
  /** Unix socket path / named pipe name override. */
  socketPath?: string;
  /** Explicit path to the bellstated binary. */
  daemonPath?: string;
  /** Spawn the daemon if none is running. Default true. */
  spawnDaemon?: boolean;
  /** Respawn + resync if the daemon dies. Default true. */
  autoRespawn?: boolean;
  /** Seconds after the last client disconnects before the daemon exits. */
  idleTimeout?: number;
  /** Persistence path override; passed to the daemon on spawn. */
  dataFile?: string;
  /** Milliseconds before a request fails. Default 5000. */
  requestTimeout?: number;
  /**
   * Enable encrypted-at-rest values (AES-256-GCM). true uses a machine-local
   * key file shared by all bellstate clients; {keyFile} scopes the key to
   * your app suite. Values written with {secure: true} are ciphertext on
   * disk and to clients without the key.
   */
  secure?: boolean | { keyFile: string };
  /**
   * Queue unconditional writes issued while the daemon is unreachable and
   * replay them after resync (bounded; CAS writes excluded). Default true.
   */
  offlineQueue?: boolean;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SetOptions {
  /**
   * Compare-and-set: only write if the key's last-modified revision equals
   * this (0 = only if the key is absent). On mismatch the promise rejects
   * with err.code === 'conflict', err.rev and err.value set.
   */
  ifRev?: number;
  /** Milliseconds until the key auto-deletes (an 'expired' change fires). */
  ttl?: number;
  /**
   * The key dies when this client disconnects, and is automatically
   * re-claimed after reconnects ('ephemeral-lost' fires if that fails).
   */
  ephemeral?: boolean;
  /** Encrypt this value at rest (requires connect({secure: ...})). */
  secure?: boolean;
  /** Skip undo recording for this mutation. */
  noRecord?: boolean;
}

export interface ChangeEvent {
  key: string;
  value: JsonValue | undefined;
  deleted: boolean;
  /** True when a TTL expiry caused the deletion. */
  expired?: boolean;
  /** True when the key was ephemeral. */
  ephemeral?: boolean;
  /** True when the value arrived via the chunked large-value path. */
  large?: boolean;
  rev: number;
}

export interface MChangeEvent {
  entries: Record<string, JsonValue>;
  del: string[];
  rev: number;
}

export interface SyncEvent {
  state: Record<string, JsonValue>;
  rev: number;
}

export interface PulseEvent {
  ch: string;
  value: JsonValue;
}

export interface ConflictError extends Error {
  code: 'conflict';
  /** The key's current revision. */
  rev: number;
  /** The key's current value (null if absent or too large to inline). */
  value: JsonValue | null;
  /** True when the current value was too large to inline in the error. */
  large?: boolean;
}

export interface PingResult {
  pong: true;
  rev: number;
  v: number;
  version: string;
}

export interface StatsResult {
  clients: number;
  keys: number;
  rev: number;
  /** Total serialized bytes of all values. */
  bytes: number;
  walBytes: number;
  uptimeMs: number;
  v: number;
  version: string;
}

export interface Peer {
  key: string;
  name: string;
  value: JsonValue | undefined;
}

export declare class BellstateClient extends EventEmitter {
  readonly namespace: string;
  readonly socketPath: string;
  /** Last seen store revision. */
  readonly rev: number;
  /** Daemon version reported at handshake. */
  readonly daemonVersion: string | null;

  constructor(opts?: ConnectOptions);

  connect(): Promise<this>;

  // Synchronous reads from the local replica
  get<T extends JsonValue = JsonValue>(key: string): T | undefined;
  /** Revision at which a key last changed (0 if absent). CAS anchor. */
  getRev(key: string): number;
  has(key: string): boolean;
  keys(prefix?: string): string[];
  getAll(): Record<string, JsonValue>;

  // Writes
  set(key: string, value: JsonValue, opts?: SetOptions): Promise<number>;
  /**
   * Atomic read-modify-write: fn(currentValue) returns the next value;
   * automatically retried with the fresh value on concurrent writes.
   */
  update<T extends JsonValue = JsonValue>(
    key: string,
    fn: (current: T | undefined) => T | Promise<T>,
    opts?: { retries?: number }
  ): Promise<{ value: T; rev: number }>;
  /**
   * Atomic per-property merge (last-writer-wins per field): fields
   * overwrite, null deletes a field, nested objects merge recursively.
   * Concurrent merges to different fields never conflict.
   */
  merge(
    key: string,
    partial: Record<string, JsonValue>,
    opts?: { ifRev?: number; noRecord?: boolean }
  ): Promise<number>;
  /** Server-side atomic increment; resolves with the new value. */
  incr(key: string, by?: number): Promise<number>;
  /** Atomically write several keys (and/or delete some) in one revision. */
  mset(entries: Record<string, JsonValue>, opts?: { del?: string[] }): Promise<number>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<number>;

  // Coordination
  /** Claim a machine-global ephemeral lock. True if acquired. */
  acquire(key: string, value?: JsonValue): Promise<boolean>;
  release(key: string): Promise<boolean>;
  /** Announce this process; the entry dies with the connection. Returns the key. */
  presence(name: string, meta?: Record<string, JsonValue>): Promise<string>;
  /** Live presence entries, optionally filtered by name. */
  peers(name?: string): Peer[];
  /** Subscribe to an exact key or 'prefix*' pattern; returns unsubscribe. */
  watch(pattern: string, callback: (change: ChangeEvent) => void): () => void;
  /**
   * Transient lane: fire-and-forget broadcast with no revision, no
   * persistence, and no ack — for high-frequency data (cursors, drag
   * motion). Silently dropped while disconnected.
   */
  pulse(channel: string, value: JsonValue, opts?: { keep?: number }): void;
  /** Subscribe to pulses on an exact channel or 'prefix*' pattern. */
  watchPulse(pattern: string, callback: (event: PulseEvent) => void): () => void;
  /** Recent history of a stream (pulses sent with keep). Memory-only. */
  history(channel: string, limit?: number): Promise<JsonValue[]>;

  // Per-client multiplayer undo (reverts YOUR ops only, as new ops)
  enableUndo(opts?: { limit?: number }): this;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  readonly undoDepth: number;
  readonly redoDepth: number;

  /** Writes waiting out a daemon outage (offline queue). */
  readonly offlineQueueSize: number;

  // Daemon management
  ping(): Promise<PingResult>;
  stats(): Promise<StatsResult>;
  /** Ask the daemon to persist and exit. */
  shutdownDaemon(): Promise<void>;
  /** Disconnect this client. The daemon keeps serving others. */
  close(): void;

  on(event: 'change', listener: (event: ChangeEvent) => void): this;
  on(event: 'mchange', listener: (event: MChangeEvent) => void): this;
  on(event: 'clear', listener: (event: { rev: number }) => void): this;
  on(event: 'sync', listener: (event: SyncEvent) => void): this;
  on(event: 'disconnect', listener: () => void): this;
  on(event: 'reconnect', listener: (event: { rev: number }) => void): this;
  on(event: 'pulse', listener: (event: PulseEvent) => void): this;
  on(event: 'ephemeral-lost', listener: (event: { key: string }) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;

  once(event: 'change', listener: (event: ChangeEvent) => void): this;
  once(event: 'reconnect', listener: (event: { rev: number }) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
}

/** Connect to the store for a namespace, spawning the daemon if needed. */
export declare function connect(opts?: ConnectOptions): Promise<BellstateClient>;

/** Compute the socket path the daemon uses for a namespace. */
export declare function socketPathFor(namespace: string): string;

/**
 * Fractional indexing: a string strictly between a and b in lexicographic
 * order (null = open bound). Lets concurrent processes insert into ordered
 * lists (layers, playlists) without renumbering or conflicts.
 */
export declare function orderBetween(a?: string | null, b?: string | null): string;
