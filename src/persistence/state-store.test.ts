import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { StateStore, type Snapshot } from './state-store.js';
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

    it('throws when the snapshot is corrupt (so recovery can probe instead of silently orphaning)', async () => {
      await writeFile(path, '{ this is not: valid json', 'utf8');
      const store = new StateStore(path);
      // A corrupt snapshot means a show may be on air; throwing (vs. the null a
      // missing file returns) lets recover() probe BS and end any orphan rather
      // than starting inactive and orphaning it.
      await expect(store.load()).rejects.toThrow(/corrupt/i);
    });

    it('throws when the snapshot exists but cannot be read (not ENOENT), so recovery still probes', async () => {
      // A directory at the snapshot path makes readFile throw EISDIR — a non-ENOENT
      // read error, the same "persisted but unreadable" condition as corrupt JSON.
      await mkdir(path);
      const store = new StateStore(path);
      await expect(store.load()).rejects.toThrow(/unreadable/i);
    });
  });

  describe('save()', () => {
    it('writes via a temp file and renames, leaving no stray temp file behind', async () => {
      const store = new StateStore(path);
      await store.save(snapshot);
      const entries = await readdir(dir);
      expect(entries).toEqual(['state.json']); // temp sibling was renamed away, not left
    });

    it('never truncates a previously-valid snapshot when a later save fails mid-write', async () => {
      const store = new StateStore(path);
      await store.save(snapshot); // a good snapshot is on disk

      // Make the temp-file write genuinely fail (no module mocking): occupy the
      // fixed temp path with a directory so writeFile(tmp) throws EISDIR.
      const tmp = join(dirname(path), `.${basename(path)}.tmp`);
      await mkdir(tmp);
      const { logger, asLogger } = fakeLogger();
      const failing = new StateStore(path, asLogger);
      await expect(failing.save({ ...snapshot, lastPostedShId: 999 })).resolves.toBeUndefined();

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
      // Occupy the fixed temp path with a directory so writeFile(tmp) throws EISDIR.
      const tmp = join(dirname(path), `.${basename(path)}.tmp`);
      await mkdir(tmp);
      await expect(store.saveStrict({ ...snapshot, lastPostedShId: 999 })).rejects.toThrow();
      const onDisk = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
      expect(onDisk.lastPostedShId).toBe(555); // old value intact, not torn
    });
  });
});
