/**
 * Restart-recovery snapshot. The authoritative liveness check is the BS on-air
 * probe (FlowsheetClient.isOnAir); this snapshot restores *who* activated, the
 * last breakpoint hour, and the last-posted sh_id (the track-dedupe key), which
 * BS can't tell us.
 */
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Activation } from '../core/state.js';
import type { Logger } from '../logger.js';

export interface Snapshot {
  phase: 'INACTIVE' | 'ACTIVATING' | 'ACTIVE' | 'DEACTIVATING';
  showId?: number;
  activatedBy?: Activation;
  lastBreakpointHour?: number;
  /** sh_id of the last entry posted; restored so a restart doesn't re-post the still-playing track. */
  lastPostedShId?: number;
}

export class StateStore {
  constructor(
    private readonly path: string,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<Snapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      // ENOENT is normal (first boot, or after a clean deactivate). Anything else
      // is worth surfacing, though there is still nothing to recover from here.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ err }, 'failed to read auto-dj state snapshot');
      }
      return null;
    }
    try {
      return JSON.parse(raw) as Snapshot;
    } catch (err) {
      // A corrupt snapshot means something WAS persisted but is now unreadable —
      // a show may be on air. Surface it loudly rather than silently orphaning it.
      this.logger?.error(
        { err },
        'auto-dj state snapshot is corrupt; cannot re-attach a running show on recovery',
      );
      return null;
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    // Write to a temp file then atomically rename. rename(2) is atomic within a
    // filesystem, so a crash mid-write can never truncate the live snapshot — a
    // bare writeFile() opens with O_TRUNC and would leave a 0-byte file, which
    // load() then treats as "no snapshot" and orphans a running show. Saves are
    // serialized through the orchestrator's promise chain, so a fixed temp name
    // is safe.
    const tmp = join(dirname(this.path), `.${basename(this.path)}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
      await rename(tmp, this.path);
    } catch (err) {
      this.logger?.warn({ err }, 'failed to persist auto-dj state snapshot');
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}
