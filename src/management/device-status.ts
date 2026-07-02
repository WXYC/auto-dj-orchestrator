/**
 * Tracks the latest Arduino heartbeat and projects the `device` block of the
 * status response. Implements DeviceStatusProvider so the coordinator can read
 * it without depending on the management channel directly.
 */
import type { AutoDJDeviceSummary } from '@wxyc/shared/auto-dj';
import type { DeviceStatusProvider } from '../ports.js';
import type { InboundMessage } from './codec.js';

type Heartbeat = Extract<InboundMessage, { type: 'heartbeat' }>;

export class DeviceStatusStore implements DeviceStatusProvider {
  private last: { heartbeat: Heartbeat; atMs: number } | null = null;
  // Last RELAY state the device actually reported. Tracked separately so a
  // heartbeat that omits the optional field doesn't flip the displayed state.
  private lastRelayAutoDjActive: boolean | undefined;

  constructor(
    private readonly offlineThresholdMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  update(heartbeat: Heartbeat): void {
    this.last = { heartbeat, atMs: this.now() };
    if (heartbeat.relay_auto_dj_active !== undefined) {
      this.lastRelayAutoDjActive = heartbeat.relay_auto_dj_active;
    }
  }

  summary(): AutoDJDeviceSummary | null {
    if (!this.last) return null;
    const online = this.now() - this.last.atMs < this.offlineThresholdMs;
    return {
      online,
      transport: this.last.heartbeat.transport,
      lastHeartbeat: new Date(this.last.atMs).toISOString(),
      // relay_auto_dj_active === false => live DJ => "dj_live"; true or
      // never-reported => "auto_dj_active" (the relay's at-rest state).
      relayState: this.lastRelayAutoDjActive === false ? 'dj_live' : 'auto_dj_active',
    };
  }
}
