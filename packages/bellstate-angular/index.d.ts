import { Signal } from '@angular/core';
import { JsonValue, SetOptions } from 'bellstate';

/**
 * Live machine-global value as a read-only Signal. Updates whenever any
 * process on the machine writes the key. Write with setBellstate().
 */
export declare function bellstateSignal<T extends JsonValue = JsonValue>(
  key: string,
  initialValue?: T
): Signal<T>;

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

export declare function deleteBellstate(key: string): Promise<boolean>;

/** Signal that is true while the main process is connected to the daemon. */
export declare function bellstateConnected(): Signal<boolean>;

/** Signal of the store revision — changes on every write on the machine. */
export declare function bellstateRev(): Signal<number>;
