import { JsonValue, ChangeEvent } from './index';

/** Payload delivered to renderer onChange callbacks. */
export type BellstateRendererEvent =
  | ({ type: 'change' } & ChangeEvent)
  | { type: 'pulse'; ch: string; value: JsonValue }
  | { type: 'clear'; rev: number }
  | { type: 'sync'; state: Record<string, JsonValue>; rev: number }
  | { type: 'disconnect' }
  | { type: 'reconnect'; rev: number };

/** The API exposed to the renderer as window.<globalName> (default: window.bellstate). */
export interface BellstateRendererApi {
  snapshot(): Promise<{ state: Record<string, JsonValue>; rev: number; namespace: string }>;
  get(key: string): Promise<JsonValue | undefined>;
  set(
    key: string,
    value: JsonValue,
    opts?: { ifRev?: number; ttl?: number; ephemeral?: boolean; secure?: boolean }
  ): Promise<number>;
  /** Atomic per-property merge; null deletes a field. Conflict-free. */
  merge(key: string, partial: Record<string, JsonValue>): Promise<number>;
  delete(key: string): Promise<boolean>;
  /** Recent history of a stream (pulses sent with keep). */
  history(channel: string, limit?: number): Promise<JsonValue[]>;
  /** Per-user undo/redo (requires initBellstate({undo: true}) in main). */
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /** Server-side atomic increment — safe under concurrent writers. */
  incr(key: string, by?: number): Promise<number>;
  /** Subscribe to store events; returns an unsubscribe function. */
  onChange(callback: (payload: BellstateRendererEvent) => void): () => void;
  /** Subscribe to an exact key or 'prefix*' pattern; returns unsubscribe. */
  watch(
    pattern: string,
    callback: (payload: { type: 'change' } & ChangeEvent) => void
  ): () => void;
  /** Fire-and-forget transient broadcast; keep:N retains bounded history. */
  pulse(channel: string, value: JsonValue, keep?: number): void;
  /** Subscribe to pulses on an exact channel or 'prefix*' pattern. */
  watchPulse(
    pattern: string,
    callback: (payload: { type: 'pulse'; ch: string; value: JsonValue }) => void
  ): () => void;
}

/** Call from an Electron preload script. Requires contextIsolation. */
export declare function exposeBellstate(globalName?: string): void;
