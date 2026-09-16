import { JsonValue } from 'bellstate';

/**
 * Live machine-global value. Re-renders when any process on the machine
 * writes the key. The setter round-trips through the daemon and resolves
 * with the new store revision.
 */
export declare function useBellstate<T extends JsonValue = JsonValue>(
  key: string,
  initialValue?: T
): [T, (next: T) => Promise<number>];

/** Server-side atomic increment bound to a key — safe under concurrent writers. */
export declare function useBellstateIncr(
  key: string
): (by?: number) => Promise<number>;

/** True while the main process is connected to the daemon. */
export declare function useBellstateStatus(): boolean;

/** The store revision — changes on every write anywhere on the machine. */
export declare function useBellstateRev(): number;
