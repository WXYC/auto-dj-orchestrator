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
import { TransientReadError, type StateStore, type Snapshot } from '../persistence/state-store.js';
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
  /**
   * Set when boot recovery read an ACTIVE snapshot but the first on-air probe
   * returned off-air (item 8). We do NOT converge on a single off-air read — a BS
   * false-negative in the eventual-consistency window right after a redeploy would
   * durably mute a live show. Instead we pause defensively, hold the snapshot here,
   * and let the reconciler re-probe: a second off-air read converges INACTIVE, an
   * on-air read re-attaches (the false negative resolved). In-memory only — a crash
   * mid-reconfirm re-reads the still-ACTIVE snapshot and simply restarts the two-read
   * sequence, so it never needs persisting.
   */
  private reconfirmOffAir: Snapshot | null = null;

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

  /**
   * Periodic reconciler (R3). Drives a *transitional* phase toward its terminal
   * phase by probing BS truth and retrying the effect — the same convergence
   * recover() runs at boot, but on a tick so an in-process failure (a failed
   * teardown left DEACTIVATING by handleEffectFailure, or a failed activation left
   * ACTIVATING) is retried without waiting for a restart. Without it, R2's "leave
   * the transitional phase durable" would have nothing to retry it in-process.
   *
   * Both transitional phases route through endPossibleOrphanAndSettle (probe on-air,
   * end any orphan, converge only if gone) — it is strictly more robust than a bare
   * end()-retry for DEACTIVATING because the tick has no prior probe, so it converges
   * correctly even when the show already ended out of band and end() would error.
   * ACTIVE / INACTIVE are no-ops. Serialized through enqueue so it can't race normal
   * operation, and the phase is re-read INSIDE the enqueued unit so a reconcile that
   * queued behind a concurrent activation/teardown no-ops once that unit converged.
   */
  reconcileTransitional(): Promise<void> {
    return this.enqueue(async () => {
      // A boot ACTIVE-snapshot-but-off-air reconfirm (item 8) takes priority: it is
      // armed while in-memory is INACTIVE, so it can't be found by the phase check.
      if (this.reconfirmOffAir) {
        await this.reconfirmActiveLiveness();
        return;
      }
      const phase = this.state.phase; // re-read inside the unit, not at call time
      if (phase === 'ACTIVATING' || phase === 'DEACTIVATING') {
        await this.endPossibleOrphanAndSettle();
      }
      // ACTIVE / INACTIVE: nothing to reconcile.
    });
  }

  /** Start the hourly-breakpoint ticker and the periodic reconciler. Idempotent. */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      void this.hourTick().catch((err) => this.deps.logger.error({ err }, 'hour tick failed'));
      void this.reconcileTransitional().catch((err) =>
        this.deps.logger.error({ err }, 'reconcile tick failed'),
      );
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
      if (err instanceof TransientReadError) {
        // A momentary read fault (a disk/mount/perms blip, e.g. mid-redeploy) is
        // uncertainty, not confirmation — do NOT end a possibly-live show. Leave the
        // on-disk state untouched; a later reconcile / the next boot retries the
        // read. Ending here on a transient blip would be dead air where a retry
        // would have re-attached.
        this.deps.logger.warn(
          { err },
          'recovery: snapshot read transiently failed; leaving state for a later retry',
        );
        return;
      }
      // A corrupt (or unknown-fault) snapshot: something was persisted but is
      // permanently unreadable, so a show may be on air with an id we can't recover.
      // Probe BS and end any orphan, then settle INACTIVE — the same shape as an
      // interrupted activation.
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
      if (snap.phase === 'ACTIVE') {
        // item 8: a single off-air read of a snapshot we believed ACTIVE is NOT
        // confirmation — a BS false-negative post-redeploy would durably mute a live
        // show. Do not settle. Pause defensively (if it really is off, no audio
        // leaks; if it's a false negative, a one-tick pause is a far smaller harm
        // than a durable INACTIVE mute), leave the ACTIVE snapshot untouched, and arm
        // a reconfirm the reconciler re-probes on the next tick.
        this.deps.arduino.send('pause');
        this.reconfirmOffAir = snap;
        this.deps.logger.warn(
          { showId: snap.showId },
          'recovery: snapshot ACTIVE but first probe off-air; reconfirming before converging',
        );
        return;
      }
      // DEACTIVATING + off-air: the operator was ending this show and it is confirmed
      // off — converge. (No false-negative reconfirm here: the intended end state is
      // off, so a momentary false-negative only reaches the state we were heading to.)
      this.deps.logger.info(
        { showId: snap.showId },
        'snapshot was deactivating and BS reports off-air; settling inactive',
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

    // phase ACTIVE (on-air, or an indeterminate probe): re-attach to the running show.
    await this.attachRecoveredShow(snap);
  }

  /**
   * Re-attach to a running show after a restart (or after a reconfirm probe resolves
   * on-air). Restores the persisted watermarks — lastBreakpointHour (so a restart
   * mid-hour still posts that hour's breakpoint instead of skipping it) and
   * lastPostedShId (so the subscriber's first poll doesn't re-post the still-playing
   * track), falling back to the current hour only if the snapshot predates breakpoint
   * tracking — then re-asserts the relay (a recovered live show must route Auto-DJ
   * audio, but 'resume' is a one-shot a crash or relay reset may have missed).
   *
   * Dispatches via applyEvent directly (NOT enqueue): recover() runs off-chain as the
   * sole writer at boot, and the reconfirm path already runs inside an enqueued unit —
   * a nested enqueue would deadlock the chain.
   */
  private async attachRecoveredShow(snap: Snapshot): Promise<void> {
    await this.applyEvent({
      kind: 'RECOVERED',
      showId: snap.showId!,
      activatedBy: snap.activatedBy ?? {
        source: 'virtual_switch',
        detail: 'recovered',
        at: this.nowIso(),
      },
      lastBreakpointHour: snap.lastBreakpointHour ?? epochHour(this.now()),
      lastPostedShId: snap.lastPostedShId,
    });
    this.deps.arduino.send('resume');
    this.deps.logger.info({ showId: snap.showId }, 'recovered active auto-dj show');
  }

  /**
   * Second half of item 8's two-read confirmation, run on a reconcile tick while a
   * reconfirm is armed. Re-probe: a second off-air read (now spanning >= one tick,
   * past the eventual-consistency window) converges INACTIVE; an on-air read means the
   * first probe was a false negative, so re-attach and resume; an indeterminate probe
   * leaves the reconfirm armed for the next tick.
   */
  private async reconfirmActiveLiveness(): Promise<void> {
    const snap = this.reconfirmOffAir;
    if (!snap) return;
    let onAir = false;
    let probeFailed = false;
    try {
      onAir = await this.deps.flowsheet.isOnAir();
    } catch (err) {
      probeFailed = true;
      this.deps.logger.warn({ err }, 'recovery: reconfirm probe failed; staying pending');
    }
    if (probeFailed) return; // still can't tell — retry next tick
    this.reconfirmOffAir = null;
    if (!onAir) {
      this.deps.logger.info('recovery: ACTIVE snapshot confirmed off-air across two reads; settling inactive');
      await this.settleInactive();
      return;
    }
    this.deps.logger.info({ showId: snap.showId }, 'recovery: reconfirm read on-air (false negative); re-attaching');
    await this.attachRecoveredShow(snap);
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
        // The ONE strict write that reaches ACTIVE (item 3). SHOW_STARTED emits no
        // PERSIST_STATE, so this is the only persist of the ACTIVATING -> ACTIVE
        // transition: a durable ACTIVE+id means "confirmed show", ACTIVATING-on-disk
        // always means "unconfirmed". If it throws, phase is already ACTIVE and
        // handleEffectFailure's START_SHOW/ACTIVE branch re-enters teardown so end()
        // reconciles BS to match — never leaving ACTIVATING-on-disk under ACTIVE.
        await this.deps.stateStore.saveStrict(snapshotOf(this.state));
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
    if (effect.type === 'START_SHOW' && this.state.phase === 'ACTIVE') {
      // The post-join strict ACTIVE persist threw: memory is ACTIVE (SHOW_STARTED
      // ran) but disk is still ACTIVATING — a split brain. There is no reducer event
      // for ACTIVE -> INACTIVE, so re-enter the UNIFIED teardown path: dispatch
      // DEACTIVATE_REQUESTED (ACTIVE -> DEACTIVATING, emits END_SHOW) and route into
      // the same END_SHOW handler above — a good end() converges INACTIVE, a failed
      // end() leaves DEACTIVATING for the reconciler. Do NOT hand-roll end() +
      // settleInactive() here: a second teardown path is exactly what this redesign
      // collapses, and any refactor that inlines it reintroduces the divergence.
      // Dispatch inline via applyEvent, NEVER enqueue() — enqueue wraps only external
      // entry points; a nested enqueue here would deadlock the outer runEffects chain
      // (this is the established re-entrant pattern, cf. the END_SHOW branch below).
      // source 'virtual_switch': the DEACTIVATE_REQUESTED event source is limited to
      // 'virtual_switch' | 'button', and the wire AutoDJActivationSource enum has no
      // internal member, so we reuse 'virtual_switch' rather than break the contract.
      this.deps.logger.warn('post-join ACTIVE persist failed; rolling the show back through teardown');
      await this.applyEvent({ kind: 'DEACTIVATE_REQUESTED', source: 'virtual_switch', at: this.nowIso() });
      return true;
    }
    if (effect.type === 'START_SHOW' && this.state.phase === 'ACTIVATING') {
      // join() threw — INDETERMINATE, not a clean failure: the request may have
      // reached BS and created a show whose id we never learned (a dropped
      // response). A durable ACTIVATING marker is ALREADY on disk (ACTIVATE_EFFECTS
      // saveStrict'd it and gated join() on it), so recovery/reconcile can probe
      // on-air and end any orphan without a show id. R2: do NOT reset to INACTIVE
      // and do NOT persist — clobbering the marker with a clean INACTIVE makes
      // recovery treat it as a clean shutdown and never probe, abandoning the
      // orphan. Just pause the relay and abandon the batch (the trailing 'resume'
      // is dropped); leave ACTIVATING in memory and on disk for the reconciler.
      this.deps.arduino.send('pause');
      return true;
    }
    if (effect.type === 'END_SHOW' && this.state.phase === 'DEACTIVATING') {
      // end() threw, so the show is STILL LIVE in BS — we have NO confirmation it
      // is off. Do NOT dispatch SHOW_ENDED: that would converge INACTIVE and
      // persist it over a live show, and because in-memory state would then be
      // INACTIVE nothing retries — a permanent orphan during normal operation
      // (the exact bug recover() was fixed to avoid, in the in-process path). R2:
      // restore safe hardware state (pause the relay) but leave the phase
      // DEACTIVATING durable and abandon the batch. reconcile() (the periodic
      // driver, item 4) retries end() and converges only when the probe confirms
      // off-air. Returning true still surfaces failedEffect === 'END_SHOW' so the
      // router answers 502 (unchanged from #20).
      this.deps.arduino.send('pause');
      return true;
    }
    return false; // POST_ENTRY / POST_BREAKPOINT / etc: logged, continue.
  }
}
