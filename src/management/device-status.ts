/**
 * Tracks the latest Arduino heartbeat and projects the `device` block of the
 * status response. Implements DeviceStatusProvider so the coordinator can read
 * it without depending on the management channel directly.
 */
import type { AutoDJDeviceSummary } from '../contracts.js';
import type { DeviceStatusProvider } from '../ports.js';
import type { InboundMessage } from './codec.js';

type Heartbeat = Extract<InboundMessage, { type: 'heartbeat' }>;

export class DeviceStatusStore implements DeviceStatusProvider {
  private last: { heartbeat: Heartbeat; atMs: number } | null = null;

  constructor(
    private readonly offlineThresholdMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  update(heartbeat: Heartbeat): void {
    this.last = { heartbeat, atMs: this.now() };
  }

  summary(): AutoDJDeviceSummary | null {
    if (!this.last) return null;
    const online = this.now() - this.last.atMs < this.offlineThresholdMs;
    return {
      online,
      transport: this.last.heartbeat.transport,
      lastHeartbeat: new Date(this.last.atMs).toISOString(),
      // relay_auto_dj_active === true => no live DJ => "auto_dj_active"
      relayState: this.last.heartbeat.relay_auto_dj_active === false ? 'dj_live' : 'auto_dj_active',
    };
  }
}
