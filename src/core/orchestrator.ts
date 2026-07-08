/**
 * Impure coordinator. Owns the activation state, feeds events through the pure
 * reducer, and executes the resulting effects against the real clients. External
 * triggers (HTTP, AzuraCast, Arduino, the hourly ticker) are serialized through
 * a promise chain so async effects never interleave state mutations; effects
 * that themselves dispatch (START_SHOW -> SHOW_STARTED) run inline within the
 * same serialized unit, avoiding deadlock.
 */
import type { AutoDJDeactivateResponse, AutoDJStatus } from '@wxyc/shared/auto-dj';
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
  lastPostedShId: s.lastPostedShId,
});

/**
 * A {@link ReduceResult} augmented with the downstream effect (if any) that
 * failed while the orchestrator ran the batch. The pure reducer can't know this
 * — it's set by the impure {@link Orchestrator} after {@link Orchestrator#runEffects}.
 * `deactivate()` returns this so the router can tell a failed teardown
 * (`failedEffect === 'END_SHOW'`) from a clean one and answer 502 vs 200.
 */
export type AppliedResult = ReduceResult & { failedEffect?: Effect['type'] };

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

  deactivate(): Promise<AppliedResult> {
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
    this.ticker = setInterval(() => {
      void this.hourTick().catch((err) => this.deps.logger.error({ err }, 'hour tick failed'));
    }, this.deps.tickIntervalMs ?? 60_000);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.deps.azuracast.stop();
  }

  /** Boot recovery: re-attach to an in-progress show only if BS confirms it is on air. */
  async recover(): Promise<void> {
    let snap: Snapshot | null;
    try {
      snap = await this.deps.stateStore.load();
    } catch (err) {
      // A corrupt snapshot: something was persisted but is unreadable, so a show
      // may be on air with an id we can't recover. Probe BS and end any orphan,
      // then settle INACTIVE — the same shape as an interrupted activation.
      this.deps.logger.error(
        { err },
        'recovery: state snapshot unreadable; probing BS for an orphan',
      );
      await this.endPossibleOrphanAndSettle();
      return;
    }
    if (!snap) return; // first boot, or a clean shutdown left no snapshot

    // ACTIVATING: activation was interrupted before we learned the show id, so
    // flowsheet.join() may or may not have created a show in BS. Probe and tear
    // down any orphan, then settle INACTIVE — activation was never confirmed, so
    // we never auto-resurrect; a human must re-activate.
    if (snap.phase === 'ACTIVATING') {
      await this.endPossibleOrphanAndSettle();
      return;
    }

    // Only ACTIVE / DEACTIVATING carry a show to re-attach to or finish.
    if (snap.phase !== 'ACTIVE' && snap.phase !== 'DEACTIVATING') return;
    if (snap.showId === undefined) {
      // Malformed (ACTIVE/DEACTIVATING with no id): treat like an unknown show.
      await this.endPossibleOrphanAndSettle();
      return;
    }

    // Distinguish "definitely off-air" (probe returned false) from "couldn't
    // tell" (probe threw — transient auth/BS error). A definitive off-air settles
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
      // The show ended out of band. Pause the relay and settle INACTIVE so a
      // re-boot doesn't re-probe the same stale snapshot.
      this.deps.logger.info(
        { showId: snap.showId },
        'snapshot was active but BS reports off-air; settling inactive',
      );
      await this.settleInactive();
      return;
    }

    if (snap.phase === 'DEACTIVATING') {
      // A teardown was in progress when we died — finish it, then settle INACTIVE.
      // Only converge if end() actually succeeded: otherwise the show may still be
      // live in BS and persisting INACTIVE would stop the next boot from re-probing
      // (a permanent orphan). Leave the DEACTIVATING snapshot so recovery retries.
      // Do NOT re-activate (that would resurrect a show the operator was ending).
      try {
        await this.deps.flowsheet.end();
      } catch (err) {
        this.deps.logger.warn(
          { err },
          'recovery: failed to finish interrupted deactivation; leaving it for the next boot to retry',
        );
        return;
      }
      await this.settleInactive();
      this.deps.logger.info(
        { showId: snap.showId },
        'finished an interrupted deactivation on recovery',
      );
      return;
    }

    // phase ACTIVE: re-attach to the running show. Restore lastPostedShId so the
    // subscriber's first poll doesn't re-post the still-playing track.
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
        lastPostedShId: snap.lastPostedShId,
      }),
    );
    // Re-assert the relay: a recovered live show must be routing Auto-DJ audio, but
    // 'resume' is a one-shot command a crash (or a relay reset) may have missed.
    this.deps.arduino.send('resume');
    this.deps.logger.info({ showId: snap.showId }, 'recovered active auto-dj show');
  }

  /**
   * Probe BS for a show we cannot manage (an interrupted activation left no show
   * id, or the snapshot is unreadable) and end any orphan. Converge to INACTIVE
   * only when the Auto-DJ is provably off — a successful end() or a definitive
   * off-air probe. end() fires only on a POSITIVE probe (ending on an indeterminate
   * probe with no show id could tear down a live human DJ's show; on-air/end are
   * dj-scoped to the Auto-DJ account, WXYC/Backend-Service#1530). An indeterminate
   * probe or a failed end() leaves the snapshot so the next boot retries — never
   * persisting INACTIVE over an orphan we could not confirm gone.
   */
  private async endPossibleOrphanAndSettle(): Promise<void> {
    let onAir = false;
    try {
      onAir = await this.deps.flowsheet.isOnAir();
    } catch (err) {
      this.deps.logger.warn(
        { err },
        'recovery: on-air probe failed with no show id; leaving it for the next boot to retry',
      );
      return;
    }
    if (!onAir) {
      // No orphan on air — nothing to end, safe to converge.
      this.deps.logger.info('recovery: no orphaned auto-dj show on air; starting inactive');
      await this.settleInactive();
      return;
    }
    // A confirmed orphan: only converge if we actually end it, else leave the
    // snapshot so the next boot re-probes and retries rather than abandoning it.
    try {
      await this.deps.flowsheet.end();
    } catch (err) {
      this.deps.logger.warn(
        { err },
        'recovery: failed to end orphaned show; leaving it for the next boot to retry',
      );
      return;
    }
    this.deps.logger.info('recovery: ended an orphaned auto-dj show');
    await this.settleInactive();
  }

  /**
   * Reset in-memory state to INACTIVE and durably record it so recovery converges
   * — a re-boot then reads INACTIVE and re-runs nothing. Best-effort: if the
   * persist fails, the next boot just re-runs the idempotent cleanup.
   */
  private async settleInactive(): Promise<void> {
    this.state = { ...initialState };
    // INACTIVE means auto-DJ is off, so the relay must not be left routing Auto-DJ
    // audio to air (it may still be in 'resume' from a prior activation). Every
    // convergence path funnels through here, so the pause is issued once and
    // consistently — including the end-an-orphan path, which otherwise ended the
    // BS show but left the relay live.
    this.deps.arduino.send('pause');
    await this.deps.stateStore.save(snapshotOf(this.state));
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
  private async applyEvent(event: Event): Promise<AppliedResult> {
    const result = reduce(this.state, event);
    if (result.rejection) return result;
    this.state = result.state;
    const failedEffect = await this.runEffects(result.effects);
    return failedEffect ? { ...result, failedEffect } : result;
  }

  /**
   * Runs a reducer-emitted effect batch. Returns the type of the effect that
   * failed and triggered a rollback (so callers — and the router, via
   * `deactivate()` — can surface it), or `null` when the whole batch ran or the
   * failure was benign (logged and skipped).
   */
  private async runEffects(effects: Effect[]): Promise<Effect['type'] | null> {
    for (const effect of effects) {
      try {
        await this.runEffect(effect);
      } catch (err) {
        this.deps.logger.error({ err, effect: effect.type }, 'effect failed');
        // If the handler rolled state back (a failed show start/end), abandon the
        // rest of THIS batch — the remaining effects were computed for the old
        // state and would otherwise re-subscribe / resume after a rollback.
        if (await this.handleEffectFailure(effect)) return effect.type;
      }
    }
    return null;
  }

  private async runEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'START_SHOW': {
        const showId = await this.deps.flowsheet.join();
        await this.applyEvent({ kind: 'SHOW_STARTED', showId, epochHour: epochHour(this.now()) });
        // SHOW_STARTED's persist is best-effort; re-persist the ACTIVE+showId marker
        // so a single dropped write can't leave ACTIVATING on disk, which recovery
        // would treat as an orphan to END — tearing down this healthy live show.
        await this.deps.stateStore.save(snapshotOf(this.state));
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
        // Persist the advanced dedupe key only after BS accepts the entry, so a
        // failed post isn't durably recorded as "already posted" (which would
        // drop the track across a restart).
        await this.applyEvent({ kind: 'ENTRY_POSTED', shId: effect.track.shId });
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
        if (this.state.phase === 'ACTIVATING') {
          // The activation-intent marker gates flowsheet.join(): if it can't be
          // made durable, don't create a BS show we couldn't recover. A failure
          // throws -> handleEffectFailure rolls back and abandons the batch.
          await this.deps.stateStore.saveStrict(snapshotOf(this.state));
        } else {
          await this.deps.stateStore.save(snapshotOf(this.state));
        }
        break;
    }
  }

  /**
   * Keep the machine from getting stuck if a show start/end fails, restoring a
   * consistent software + hardware state. Returns true when it handled a
   * rollback (so runEffects abandons the rest of the batch).
   */
  private async handleEffectFailure(effect: Effect): Promise<boolean> {
    if (effect.type === 'PERSIST_STATE' && this.state.phase === 'ACTIVATING') {
      // The activation-intent persist failed. Abort before START_SHOW/join() so
      // we never create a BS show with no durable marker to recover it: revert to
      // INACTIVE and pause, abandoning the rest of the batch.
      this.deps.logger.warn('activation-intent persist failed; aborting activation');
      this.state = { ...initialState };
      this.deps.arduino.send('pause');
      return true;
    }
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
