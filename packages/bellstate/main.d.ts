import { ConnectOptions, BellstateClient } from './index';

export interface InitBellstateOptions extends ConnectOptions {
  /** Enable per-user undo/redo, exposed to renderers via window.bellstate. */
  undo?: boolean | { limit?: number };
}

/**
 * Call once from the Electron main process after app.whenReady().
 * Connects to the daemon and bridges the store to all renderers over IPC.
 */
export declare function initBellstate(opts?: InitBellstateOptions): Promise<BellstateClient>;

export declare const CHANNEL: {
  snapshot: string;
  get: string;
  set: string;
  delete: string;
  change: string;
};
