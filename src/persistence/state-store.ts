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

/**
 * The snapshot exists but is PERMANENTLY unreadable — corrupt JSON, or a read
 * fault whose errno we don't recognize. A show may be on air with an id we can't
 * recover, so recover() must probe BS and end any orphan rather than mistake this
 * for "no snapshot" and orphan a live show.
 */
export class CorruptSnapshotError extends Error {}

/**
 * The snapshot read failed on a RETRIABLE fault — a transient disk/mount/perms
 * blip, the kind a redeploy can momentarily surface. recover() treats this like an
 * indeterminate probe: leave the on-disk state and let a later reconcile / the next
 * boot retry, rather than ending a possibly-live show on a momentary read error.
 */
export class TransientReadError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(`auto-dj state snapshot read failed transiently (${code})`, options);
  }
}

// errnos treated as retriable rather than permanent corruption. A redeploy can
// momentarily surface these (EIO disk fault, EACCES ownership/perms change, EISDIR
// mid-mount, EBUSY/EAGAIN/ETIMEDOUT). Deliberately conservative: an UNKNOWN errno
// falls through to CorruptSnapshotError (probe-and-end), so a misclassified fault
// fails safe toward ending an orphan, never toward leaving one running. Widen only
// with evidence.
const RETRIABLE_READ_ERRNOS = new Set(['EIO', 'EACCES', 'EAGAIN', 'EBUSY', 'EISDIR', 'ETIMEDOUT']);

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
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT is normal (first boot, or after a clean deactivate) -> null.
      if (code === 'ENOENT') return null;
      // A retriable fault (a redeploy-time disk/mount/perms blip) is uncertainty,
      // not confirmation: recover() leaves the snapshot and retries rather than
      // ending a possibly-live show. An unknown errno fails safe as CorruptSnapshot
      // (probe-and-end) — never leave a real orphan running on a misclassification.
      if (code && RETRIABLE_READ_ERRNOS.has(code)) {
        throw new TransientReadError(code, { cause: err });
      }
      throw new CorruptSnapshotError('auto-dj state snapshot is unreadable', { cause: err });
    }
    try {
      return JSON.parse(raw) as Snapshot;
    } catch (err) {
      // A corrupt (parse-error) snapshot is PERMANENT: something WAS persisted but is
      // now unreadable — a show may be on air. Throw (rather than returning null,
      // which is indistinguishable from "no snapshot") so recover() probes BS and
      // ends any orphan instead of starting inactive and orphaning it.
      throw new CorruptSnapshotError('auto-dj state snapshot is corrupt', { cause: err });
    }
  }

  /**
   * Atomically persist a snapshot, throwing on failure. Used to gate a network
   * call on a durable write (the ACTIVATING intent — see the orchestrator).
   */
  async saveStrict(snapshot: Snapshot): Promise<void> {
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
      // recursive so a stray directory at the fixed temp path can't wedge every
      // future write (writeFile would keep throwing EISDIR otherwise).
      await rm(tmp, { force: true, recursive: true }).catch(() => {});
      throw err;
    }
  }

  /** Best-effort persist: a failure is logged, not thrown. */
  async save(snapshot: Snapshot): Promise<void> {
    try {
      await this.saveStrict(snapshot);
    } catch (err) {
      this.logger?.warn({ err }, 'failed to persist auto-dj state snapshot');
    }
  }
}
