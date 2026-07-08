/**
 * Status-projection selectors. `reduceStatusBelowDj` is the role-reduced view
 * served to authenticated users below `dj` (networking-spec §3.10.4: "dj role
 * or higher for full status"). Per #21 it must strip identity/internal fields
 * in BOTH the active and inactive branches — `lastDeactivatedBy` leaks the
 * deactivating DJ's Better Auth user ID while auto-DJ is off — while keeping
 * the publicly-broadcast track and the device block so the greyscale dj-site
 * member banner stays legible.
 */
import { describe, it, expect } from 'vitest';
import type { AutoDJStatus } from '@wxyc/shared/auto-dj';
import { reduceStatusBelowDj } from './selectors.js';

const DEVICE = {
  online: true,
  transport: 'ethernet',
  lastHeartbeat: '2026-07-07T00:00:00.000Z',
  relayState: 'auto_dj_active',
} as const;

const FULL_ACTIVE: AutoDJStatus = {
  active: true,
  activatedBy: { source: 'virtual_switch', userId: 'u1', userName: 'DJ Moonbeam' },
  activatedAt: '2026-07-07T00:00:00.000Z',
  showId: 42,
  currentTrack: {
    artist: 'Juana Molina',
    title: 'la paradoja',
    album: 'DOGA',
    detectedAt: '2026-07-07T00:00:00.000Z',
  },
  device: DEVICE,
};

const FULL_INACTIVE: AutoDJStatus = {
  active: false,
  lastDeactivatedAt: '2026-07-07T01:00:00.000Z',
  lastDeactivatedBy: { source: 'virtual_switch', userId: 'u1', userName: 'DJ Moonbeam' },
  device: DEVICE,
};

describe('reduceStatusBelowDj', () => {
  it('drops activatedBy and showId but keeps the track in the active branch', () => {
    const reduced = reduceStatusBelowDj(FULL_ACTIVE);
    expect(reduced).toEqual({
      active: true,
      activatedAt: '2026-07-07T00:00:00.000Z',
      currentTrack: FULL_ACTIVE.currentTrack,
      device: DEVICE,
    });
    expect(reduced).not.toHaveProperty('activatedBy');
    expect(reduced).not.toHaveProperty('showId');
  });

  it('drops lastDeactivatedBy in the inactive branch (identity leaks when off, too)', () => {
    const reduced = reduceStatusBelowDj(FULL_INACTIVE);
    expect(reduced).toEqual({
      active: false,
      lastDeactivatedAt: '2026-07-07T01:00:00.000Z',
      device: DEVICE,
    });
    expect(reduced).not.toHaveProperty('lastDeactivatedBy');
  });

  it('does not mutate the input status', () => {
    const input = structuredClone(FULL_ACTIVE);
    reduceStatusBelowDj(input);
    expect(input).toEqual(FULL_ACTIVE);
  });
});
