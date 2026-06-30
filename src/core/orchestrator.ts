/**
 * Impure coordinator. Owns the activation state, feeds events through the pure
 * reducer, and executes the resulting effects against the real clients. External
 * triggers (HTTP, AzuraCast, Arduino, the hourly ticker) are serialized through
 * a promise chain so async effects never interleave state mutations; effects
 * that themselves dispatch (START_SHOW -> SHOW_STARTED) run inline within the
 * same serialized unit, avoiding deadlock.
 */
import type { AutoDJDeactivateResponse, AutoDJStatus } from '../contracts.js';
import type { Logger } from '../logger.js';
import type { ArduinoCommandSink, DeviceStatusProvider } from '../ports.js';
import type { FlowsheetClient } from '../backend/flowsheet-client.js';
import type { AzuraCastSource } from '../azuracast/subscriber.js';
import type { StateStore, Snapshot } from '../persistence/state-store.js';
import { epochHour } from '../time.js';
import { reduce, type Effect, type Event, type ReduceResult } from './activation-state-machine.js';
import { selectDeactivateResponse, selectStatus } from './selectors.js';
import { initialState, type ActivationState, type NowPlaying } from './state.js';

export interface OrchestratorDeps {
  flowsheet: FlowsheetClient;
  azuracast: AzuraCastSource;
  arduino: ArduinoCommandSink;
  device: DeviceStatusProvider;
  stateStore: StateStore;
  logger: Logger;
  now?: () => number;
  /** Hourly-breakpoint ticker cadence; defaults to 60s. */
  tickIntervalMs?: number;
}

const snapshotOf = (s: ActivationState): Snapshot => ({
  phase: s.phase,
  showId: s.showId,
  activatedBy: s.activatedBy,
  lastBreakpointHour: s.lastBreakpointHour,
});

export class Orchestrator {
  private state: ActivationState = initialState;
  private chain: Promise<unknown> = Promise.resolve();
  private ticker: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
  }

  getStatus(): AutoDJStatus {
    return selectStatus(this.state, this.deps.device.summary());
  }

  getDeactivateResponse(): AutoDJDeactivateResponse {
    return selectDeactivateResponse(this.state);
  }

  // ── External entry points (serialized) ─────────────────────────────────
  activate(by: { userId?: string; userName?: string }): Promise<ReduceResult> {
    return this.enqueue(() =>
      this.applyEvent({
        kind: 'ACTIVATE_REQUESTED',
        source: 'virtual_switch',
        userId: by.userId,
        userName: by.userName,
        at: this.nowIso(),
      }),
    );
  }

  deactivate(): Promise<ReduceResult> {
    return this.enqueue(() =>
      this.applyEvent({
        kind: 'DEACTIVATE_REQUESTED',
        source: 'virtual_switch',
        at: this.nowIso(),
      }),
    );
  }

  buttonToggled(): Promise<ReduceResult> {
    return this.enqueue(() => this.applyEvent({ kind: 'BUTTON_TOGGLED', at: this.nowIso() }));
  }

  relayState(isLive: boolean): Promise<ReduceResult> {
    return this.enqueue(() => this.applyEvent({ kind: 'RELAY_STATE', isLive, at: this.nowIso() }));
  }

  onTrack(track: NowPlaying): Promise<ReduceResult> {
    return this.enqueue(() => this.applyEvent({ kind: 'NOW_PLAYING', track, at: this.nowIso() }));
  }

  onLive(isLive: boolean): Promise<ReduceResult> {
    return this.relayState(isLive);
  }

  hourTick(): Promise<ReduceResult> {
    return this.enqueue(() =>
      this.applyEvent({ kind: 'HOUR_TICK', epochHour: epochHour(this.now()) }),
    );
  }

  /** Start the hourly-breakpoint ticker. Idempotent. */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.hourTick(), this.deps.tickIntervalMs ?? 60_000);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.deps.azuracast.stop();
  }

  /** Boot recovery: re-attach to an in-progress show only if BS confirms it is on air. */
  async recover(): Promise<void> {
    const snap = await this.deps.stateStore.load();
    if (!snap || snap.showId === undefined) return;
    if (snap.phase !== 'ACTIVE' && snap.phase !== 'DEACTIVATING') return;

    // Distinguish "definitely off-air" (probe returned false) from "couldn't
    // tell" (probe threw — transient auth/BS error). A definitive off-air starts
    // INACTIVE; an indeterminate probe trusts the snapshot and re-attaches, so a
    // routine redeploy during a transient BS blip doesn't orphan a live show
    // (which then couldn't be ended via the API).
    let onAir = false;
    let probeFailed = false;
    try {
      onAir = await this.deps.flowsheet.isOnAir();
    } catch (err) {
      probeFailed = true;
      this.deps.logger.warn({ err }, 'recovery on-air probe failed; trusting the snapshot');
    }
    if (!onAir && !probeFailed) {
      this.deps.logger.info('snapshot was active but BS reports off-air; starting inactive');
      return;
    }

    if (snap.phase === 'DEACTIVATING') {
      // A teardown was in progress when we died — finish it, do NOT re-activate
      // (that would resurrect a show the operator was turning off, possibly on
      // top of a live DJ).
      try {
        await this.deps.flowsheet.end();
      } catch (err) {
        this.deps.logger.warn({ err }, 'recovery: failed to finish interrupted deactivation');
      }
      this.deps.logger.info(
        { showId: snap.showId },
        'finished an interrupted deactivation on recovery',
      );
      return;
    }

    // phase ACTIVE: re-attach to the running show.
    await this.enqueue(() =>
      this.applyEvent({
        kind: 'RECOVERED',
        showId: snap.showId!,
        activatedBy: snap.activatedBy ?? {
          source: 'virtual_switch',
          detail: 'recovered',
          at: this.nowIso(),
        },
        epochHour: epochHour(this.now()),
      }),
    );
    this.deps.logger.info({ showId: snap.showId }, 'recovered active auto-dj show');
  }

  // ── Internals ──────────────────────────────────────────────────────────
  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reduce one event and execute its effects. NOT serialized (callers serialize). */
  private async applyEvent(event: Event): Promise<ReduceResult> {
    const result = reduce(this.state, event);
    if (result.rejection) return result;
    this.state = result.state;
    await this.runEffects(result.effects);
    return result;
  }

  private async runEffects(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      try {
        await this.runEffect(effect);
      } catch (err) {
        this.deps.logger.error({ err, effect: effect.type }, 'effect failed');
        // If the handler rolled state back (a failed show start/end), abandon the
        // rest of THIS batch — the remaining effects were computed for the old
        // state and would otherwise re-subscribe / resume after a rollback.
        if (await this.handleEffectFailure(effect)) return;
      }
    }
  }

  private async runEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'START_SHOW': {
        const showId = await this.deps.flowsheet.join();
        await this.applyEvent({ kind: 'SHOW_STARTED', showId, epochHour: epochHour(this.now()) });
        // Post the currently-playing track as the show's opening entry (the
        // subscriber runs continuously, so no NOW_PLAYING arrives just for
        // having activated).
        const opening = this.deps.azuracast.current();
        if (opening) {
          await this.applyEvent({ kind: 'NOW_PLAYING', track: opening, at: this.nowIso() });
        }
        break;
      }
      case 'END_SHOW': {
        await this.deps.flowsheet.end();
        await this.applyEvent({ kind: 'SHOW_ENDED' });
        break;
      }
      case 'POST_ENTRY':
        await this.deps.flowsheet.addEntry(effect.track);
        break;
      case 'POST_BREAKPOINT':
        await this.deps.flowsheet.addBreakpoint();
        // Mark the hour posted only after success, so a transient failure retries.
        await this.applyEvent({ kind: 'BREAKPOINT_POSTED', epochHour: effect.epochHour });
        break;
      case 'SEND_ARDUINO_COMMAND':
        this.deps.arduino.send(effect.action);
        break;
      case 'PERSIST_STATE':
        await this.deps.stateStore.save(snapshotOf(this.state));
        break;
    }
  }

  /**
   * Keep the machine from getting stuck if a show start/end fails, restoring a
   * consistent software + hardware state. Returns true when it handled a
   * rollback (so runEffects abandons the rest of the batch).
   */
  private async handleEffectFailure(effect: Effect): Promise<boolean> {
    if (effect.type === 'START_SHOW' && this.state.phase === 'ACTIVATING') {
      // Activation failed: revert to INACTIVE and pause the Arduino (the rest of
      // the batch, which would have sent 'resume', is abandoned). The subscriber
      // keeps running — it monitors AzuraCast continuously.
      this.state = { ...initialState };
      this.deps.arduino.send('pause');
      await this.deps.stateStore.save(snapshotOf(this.state));
      return true;
    }
    if (effect.type === 'END_SHOW' && this.state.phase === 'DEACTIVATING') {
      // Treat as ended; better INACTIVE than stuck deactivating. Finish the
      // cleanup the aborted batch would have done.
      this.deps.arduino.send('pause');
      await this.applyEvent({ kind: 'SHOW_ENDED' });
      return true;
    }
    return false; // POST_ENTRY / POST_BREAKPOINT / etc: logged, continue.
  }
}
