import { JsonValue, SetOptions } from 'bellstate';

/** Matches svelte's Readable contract without depending on svelte. */
export interface BellstateReadable<T> {
  subscribe(run: (value: T) => void): () => void;
}

export interface BellstateWritable<T> extends BellstateReadable<T> {
  /** Writes through the daemon; resolves with the new store revision. */
  set(value: T): Promise<number>;
  /** Read-modify-write from the local replica (not atomic across processes). */
  update(fn: (current: T) => T): Promise<number>;
}

/**
 * Live machine-global value as a writable svelte store:
 * `const todos = bellstateStore('todos', [])` → `$todos`, `bind:value`.
 * set/update write through the daemon (all processes see them).
 */
export declare function bellstateStore<T extends JsonValue = JsonValue>(
  key: string,
  initialValue?: T
): BellstateWritable<T>;

/** Write a key; resolves with the new store revision. */
export declare function setBellstate(
  key: string,
  value: JsonValue,
  opts?: SetOptions
): Promise<number>;

/** Atomic per-property merge; null deletes a field. Conflict-free. */
export declare function mergeBellstate(
  key: string,
  partial: Record<string, JsonValue>
): Promise<number>;

/** Server-side atomic increment — safe under concurrent writers. */
export declare function incrBellstate(key: string, by?: number): Promise<number>;

/** Store that is true while the main process is connected to the daemon. */
export declare function bellstateConnected(): BellstateReadable<boolean>;

/** Store of the store revision — changes on every write on the machine. */
export declare function bellstateRev(): BellstateReadable<number>;
