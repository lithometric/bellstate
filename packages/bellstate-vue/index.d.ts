import { WritableComputedRef, Ref, DeepReadonly } from 'vue';
import { JsonValue, SetOptions } from 'bellstate';

/**
 * Live machine-global value as a writable computed ref — works with
 * v-model. Reading tracks the key; assigning writes through the daemon
 * (fire-and-forget from the ref; use setBellstate() to await the rev).
 */
export declare function useBellstate<T extends JsonValue = JsonValue>(
  key: string,
  initialValue?: T
): WritableComputedRef<T>;

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
export declare function useBellstateIncr(
  key: string
): (by?: number) => Promise<number>;

/** Read-only ref that is true while the main process is connected. */
export declare function useBellstateStatus(): DeepReadonly<Ref<boolean>>;

/** Read-only ref of the store revision — changes on every write. */
export declare function useBellstateRev(): DeepReadonly<Ref<number>>;
