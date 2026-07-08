import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CorruptSnapshotError,
  StateStore,
  TransientReadError,
  type Snapshot,
} from './state-store.js';
import type { Logger } from '../logger.js';

const fakeLogger = () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger, asLogger: logger as unknown as Logger };
};

const snapshot: Snapshot = {
  phase: 'ACTIVE',
  showId: 789,
  activatedBy: { source: 'virtual_switch', userId: 'u1', at: '2026-03-07T22:00:00.000Z' },
  lastBreakpointHour: 100,
  lastPostedShId: 555,
};

describe('StateStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'auto-dj-state-'));
    path = join(dir, 'state.json');
  });

  afterEach(async () => {
    // A failure-injection test may leave the dir read-only; restore write so rm can
    // unlink its contents.
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a snapshot through save then load', async () => {
    const store = new StateStore(path);
    await store.save(snapshot);
    expect(await store.load()).toEqual(snapshot);
  });

  describe('load()', () => {
    it('returns null and does not warn when the snapshot is missing (ENOENT)', async () => {
      const { logger, asLogger } = fakeLogger();
      const store = new StateStore(join(dir, 'does-not-exist.json'), asLogger);
      expect(await store.load()).toBeNull();
      // First boot / after a clean deactivate is normal — no noise.
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('throws CorruptSnapshotError when the snapshot is corrupt JSON (recovery probes, not orphans)', async () => {
      await writeFile(path, '{ this is not: valid json', 'utf8');
      const store = new StateStore(path);
      // A corrupt (parse-error) snapshot is PERMANENT: a show may be on air, so
      // throwing CorruptSnapshotError (vs. the null a missing file returns) lets
      // recover() probe BS and end any orphan rather than orphaning it.
      await expect(store.load()).rejects.toBeInstanceOf(CorruptSnapshotError);
    });

    it('throws TransientReadError on a retriable read fault (EISDIR), so recovery does not end a live show', async () => {
      // A directory at the snapshot path makes readFile throw EISDIR — a *retriable*
      // fault (item 7): a redeploy can momentarily surface EISDIR/EACCES/EIO. Unlike
      // corrupt JSON this is uncertainty, not confirmation, so recover() must leave
      // the on-disk state and retry rather than ending a possibly-live show.
      await mkdir(path);
      const store = new StateStore(path);
      const err = await store.load().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransientReadError);
      expect((err as TransientReadError).code).toBe('EISDIR');
    });
  });

  describe('save()', () => {
    it('writes via a temp file and renames, leaving no stray temp file behind', async () => {
      const store = new StateStore(path);
      await store.save(snapshot);
      const entries = await readdir(dir);
      expect(entries).toEqual(['state.json']); // temp sibling was renamed away, not left
    });

    it('gives each write a unique temp path so concurrent writes do not collide', async () => {
      const store = new StateStore(path);
      // Fire several writes concurrently. A shared temp path would let them race on the
      // same file — one rename removing the file another is mid-write on (ENOENT), or a
      // stray temp left behind. Unique per-write temp paths let them all complete and
      // leave only the final snapshot.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.saveStrict({ ...snapshot, lastPostedShId: i })),
      );
      const entries = await readdir(dir);
      expect(entries).toEqual(['state.json']); // no stray .tmp files
      const onDisk = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
      expect(typeof onDisk.lastPostedShId).toBe('number'); // a valid, non-torn snapshot
    });

    it('never truncates a previously-valid snapshot when a later save fails mid-write', async () => {
      const store = new StateStore(path, fakeLogger().asLogger);
      await store.save(snapshot); // a good snapshot is on disk

      // Make the temp-file write genuinely fail (no module mocking): a read-only parent
      // directory makes writeFile(tmp) throw EACCES. (Temp paths are per-write unique
      // now, so occupying a fixed name no longer works — and this exercises atomicity
      // regardless of the temp name.)
      await chmod(dir, 0o555);
      const { logger, asLogger } = fakeLogger();
      const failing = new StateStore(path, asLogger);
      await expect(failing.save({ ...snapshot, lastPostedShId: 999 })).resolves.toBeUndefined();
      await chmod(dir, 0o755); // restore so the read below (and cleanup) can proceed

      // The live snapshot is intact (the old value), not a 0-byte/torn file that
      // load() would treat as "no snapshot" and orphan a running show.
      const onDisk = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
      expect(onDisk.lastPostedShId).toBe(555);
      expect(logger.warn).toHaveBeenCalledTimes(1); // failure surfaced, not thrown
    });

    it('logs a warning but does not throw when persistence fails', async () => {
      const { logger, asLogger } = fakeLogger();
      // A path whose parent directory does not exist makes writeFile fail (ENOENT).
      const store = new StateStore(join(dir, 'missing-subdir', 'state.json'), asLogger);
      await expect(store.save(snapshot)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveStrict()', () => {
    it('round-trips a snapshot like save()', async () => {
      const store = new StateStore(path);
      await store.saveStrict(snapshot);
      expect(await store.load()).toEqual(snapshot);
    });

    it('throws when the write fails, so a gating persist can abort the batch', async () => {
      // A path whose parent directory does not exist makes writeFile fail (ENOENT).
      const store = new StateStore(join(dir, 'missing-subdir', 'state.json'));
      await expect(store.saveStrict(snapshot)).rejects.toThrow();
    });

    it('does not corrupt the live snapshot when a strict write fails', async () => {
      const store = new StateStore(path);
      await store.save(snapshot); // a good snapshot is on disk
      // A read-only parent directory makes writeFile(tmp) throw EACCES.
      await chmod(dir, 0o555);
      await expect(store.saveStrict({ ...snapshot, lastPostedShId: 999 })).rejects.toThrow();
      await chmod(dir, 0o755);
      const onDisk = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
      expect(onDisk.lastPostedShId).toBe(555); // old value intact, not torn
    });
  });
});
