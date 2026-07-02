/**
 * Ports the coordinator depends on, decoupling it from the management channel.
 * `CommandQueue` implements `ArduinoCommandSink` and `DeviceStatusStore`
 * implements `DeviceStatusProvider` (src/management/).
 */
import type { AutoDJCommandAction, AutoDJDeviceSummary } from '@wxyc/shared/auto-dj';

/** Sink for commands the orchestrator dispatches to the Arduino (pause/resume/...). */
export interface ArduinoCommandSink {
  send(action: AutoDJCommandAction): void;
}

/** Source of the Arduino device summary for status responses (null until first heartbeat). */
export interface DeviceStatusProvider {
  summary(): AutoDJDeviceSummary | null;
}
