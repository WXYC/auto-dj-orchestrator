/**
 * Ports the coordinator depends on but that are implemented elsewhere (or in a
 * later PR). Keeping them as interfaces lets PR A wire the core + virtual-switch
 * API against simple stubs, while PR B supplies the real management channel.
 */
import type { AutoDJCommandAction, AutoDJDeviceSummary } from './contracts.js';

/** Sink for commands the orchestrator dispatches to the Arduino (pause/resume/...). */
export interface ArduinoCommandSink {
  send(action: AutoDJCommandAction): void;
}

/** Source of the Arduino device summary for status responses (null until first heartbeat). */
export interface DeviceStatusProvider {
  summary(): AutoDJDeviceSummary | null;
}

/** No-op command sink used until the management channel (PR B) is wired. */
export const noopArduinoSink: ArduinoCommandSink = { send: () => {} };

/** Device provider that reports "never connected" until PR B replaces it. */
export const noDeviceProvider: DeviceStatusProvider = { summary: () => null };
