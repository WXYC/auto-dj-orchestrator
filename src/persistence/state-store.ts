/**
 * Restart-recovery snapshot. The authoritative liveness check is the BS on-air
 * probe (FlowsheetClient.isOnAir); this snapshot restores *who* activated and
 * the last breakpoint hour, which BS can't tell us.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Activation } from '../core/state.js';
import type { Logger } from '../logger.js';

export interface Snapshot {
  phase: 'INACTIVE' | 'ACTIVATING' | 'ACTIVE' | 'DEACTIVATING';
  showId?: number;
  activatedBy?: Activation;
  lastBreakpointHour?: number;
}

export class StateStore {
  constructor(
    private readonly path: string,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<Snapshot | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Snapshot;
    } catch {
      return null;
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    try {
      await writeFile(this.path, JSON.stringify(snapshot), 'utf8');
    } catch (err) {
      this.logger?.warn({ err }, 'failed to persist auto-dj state snapshot');
    }
  }
}
