import { describe, it, expect } from 'vitest';
import { DeviceStatusStore } from './device-status.js';
import type { InboundMessage } from './codec.js';

type Heartbeat = Extract<InboundMessage, { type: 'heartbeat' }>;
const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  type: 'heartbeat',
  state: 'CONNECTED',
  transport: 'ethernet',
  uptime_s: 1,
  free_ram: 1,
  firmware_version: '2.0.0',
  config_hash: 'a',
  loop_max_ms: 1,
  reconnect_count: 0,
  tracks_detected: 0,
  tracks_posted: 0,
  errors_since_boot: 0,
  ...over,
});

describe('DeviceStatusStore', () => {
  it('is null until the first heartbeat', () => {
    expect(new DeviceStatusStore(60_000, () => 0).summary()).toBeNull();
  });

  it('reports online and maps relay state', () => {
    const now = 1000;
    const store = new DeviceStatusStore(60_000, () => now);
    store.update(hb({ relay_auto_dj_active: true, transport: 'wifi' }));
    expect(store.summary()).toMatchObject({
      online: true,
      transport: 'wifi',
      relayState: 'auto_dj_active',
    });

    store.update(hb({ relay_auto_dj_active: false }));
    expect(store.summary()?.relayState).toBe('dj_live');
  });

  it('keeps the last reported relay state when a heartbeat omits the field', () => {
    const store = new DeviceStatusStore(60_000, () => 1000);
    store.update(hb({ relay_auto_dj_active: false })); // live DJ
    expect(store.summary()?.relayState).toBe('dj_live');
    store.update(hb({})); // omits the field
    expect(store.summary()?.relayState).toBe('dj_live'); // not flipped to auto_dj_active
  });

  it('goes offline once the heartbeat is older than the threshold', () => {
    let now = 1000;
    const store = new DeviceStatusStore(60_000, () => now);
    store.update(hb());
    now = 1000 + 59_000;
    expect(store.summary()?.online).toBe(true);
    now = 1000 + 61_000;
    expect(store.summary()?.online).toBe(false);
  });
});
