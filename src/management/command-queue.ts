/**
 * Pending commands for the Arduino, shared by the WS push path and the HTTP
 * poll fallback. `send` (the ArduinoCommandSink) enqueues and notifies a
 * listener (the WS server pushes immediately); HTTP fallback reads `getPending`
 * and the Arduino acks each by id, which removes it.
 */
import type { AutoDJCommand, AutoDJCommandAction } from '@wxyc/shared/auto-dj';
import type { ArduinoCommandSink } from '../ports.js';

/**
 * Absolute, idempotent power states: pause and resume each fully describe the
 * desired relay state, so only the most recent one is meaningful. A newer one
 * supersedes any older still-unacked power command (see `send`).
 */
const POWER_ACTIONS = new Set<AutoDJCommandAction>(['pause', 'resume']);

export class CommandQueue implements ArduinoCommandSink {
  private pending: AutoDJCommand[] = [];
  private seq = 0;
  private listener: ((command: AutoDJCommand) => void) | null = null;

  /** The WS server registers here to push commands as they are enqueued. */
  setListener(fn: ((command: AutoDJCommand) => void) | null): void {
    this.listener = fn;
  }

  send(action: AutoDJCommandAction): void {
    const command: AutoDJCommand = { type: 'command', id: `cmd_${++this.seq}`, action };
    // Collapse superseded power commands so the queue can't grow without bound
    // while the device is offline (nothing acks), and so a reconnect flush
    // replays just the current intent instead of a stale on/off history. Scoped
    // to POWER_ACTIONS so a future non-idempotent action is never dropped.
    if (POWER_ACTIONS.has(action)) {
      this.pending = this.pending.filter((c) => !POWER_ACTIONS.has(c.action));
    }
    this.pending.push(command);
    this.listener?.(command);
  }

  /** Snapshot of unacknowledged commands (HTTP GET /commands). */
  getPending(): AutoDJCommand[] {
    return [...this.pending];
  }

  /** Remove a command once the Arduino acknowledges it. */
  ack(id: string): void {
    this.pending = this.pending.filter((c) => c.id !== id);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
