import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { FlowsheetClient } from '../backend/flowsheet-client.js';
import type { AzuraCastSource } from '../azuracast/subscriber.js';
import type { StateStore, Snapshot } from '../persistence/state-store.js';
import type { ArduinoCommandSink } from '../ports.js';
import type { NowPlaying } from './state.js';

const HOUR = 3_600_000;
const track = (shId: number): NowPlaying => ({
  shId,
  artist: 'Cat Power',
  title: 'Werewolf',
  album: 'You Are Free',
  isLive: false,
});

function harness(opts?: {
  isOnAir?: boolean;
  snapshot?: Snapshot | null;
  startHourMs?: number;
  currentTrack?: NowPlaying | null;
}) {
  let nowMs = opts?.startHourMs ?? 100 * HOUR;
  let nextShowId = 700;
  const flowsheet = {
    join: vi.fn(async () => ++nextShowId),
    end: vi.fn(async () => {}),
    addEntry: vi.fn(async () => {}),
    addBreakpoint: vi.fn(async () => {}),
    isOnAir: vi.fn(async () => opts?.isOnAir ?? false),
  };
  const azuracast = {
    start: vi.fn(),
    stop: vi.fn(),
    current: vi.fn(() => opts?.currentTrack ?? null),
  } satisfies AzuraCastSource;
  const arduino = { send: vi.fn() } satisfies ArduinoCommandSink;
  let saved: Snapshot | null = opts?.snapshot ?? null;
  const stateStore = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (s: Snapshot) => {
      saved = s;
    }),
    saveStrict: vi.fn(async (s: Snapshot) => {
      saved = s;
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const orchestrator = new Orchestrator({
    flowsheet: flowsheet as unknown as FlowsheetClient,
    azuracast,
    arduino,
    device: { summary: () => null },
    stateStore: stateStore as unknown as StateStore,
    logger: logger as never,
    now: () => nowMs,
  });
  return {
    orchestrator,
    flowsheet,
    azuracast,
    arduino,
    stateStore,
    setNow: (ms: number) => (nowMs = ms),
  };
}

describe('Orchestrator — happy path', () => {
  it('activate -> join, track -> entry, hour -> breakpoint, deactivate -> end', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1', userName: 'DJ Moonbeam' });
    expect(h.flowsheet.join).toHaveBeenCalledTimes(1);
    expect(h.arduino.send).toHaveBeenCalledWith('resume');
    let status = h.orchestrator.getStatus();
    expect(status.active).toBe(true);
    expect(status.showId).toBe(701);

    await h.orchestrator.onTrack(track(1));
    expect(h.flowsheet.addEntry).toHaveBeenCalledWith(track(1));

    h.setNow(101 * HOUR); // cross the hour boundary
    await h.orchestrator.hourTick();
    expect(h.flowsheet.addBreakpoint).toHaveBeenCalledTimes(1);

    await h.orchestrator.deactivate();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1);
    expect(h.arduino.send).toHaveBeenCalledWith('pause');
    status = h.orchestrator.getStatus();
    expect(status.active).toBe(false);
    expect(status.lastDeactivatedBy?.source).toBe('virtual_switch');
  });
});

describe('Orchestrator — conflict resolution', () => {
  it('a live DJ preempts auto-DJ; no auto-reactivation, but the latch clears so a human can re-activate', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' });
    await h.orchestrator.relayState(true); // live DJ on air
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1);
    const status = h.orchestrator.getStatus();
    expect(status.active).toBe(false);
    expect(status.lastDeactivatedBy).toEqual({ source: 'relay', detail: 'Live DJ detected' });

    await h.orchestrator.relayState(false); // live DJ leaves (subscriber runs continuously)
    expect(h.orchestrator.getStatus().active).toBe(false); // no AUTO reactivation
    expect(h.flowsheet.join).toHaveBeenCalledTimes(1); // not auto re-joined

    // The liveDj latch cleared, so an explicit re-activation now succeeds.
    const reactivate = await h.orchestrator.activate({ userId: 'u1' });
    expect(reactivate.rejection).toBeUndefined();
    expect(h.orchestrator.getStatus().active).toBe(true);
    expect(h.flowsheet.join).toHaveBeenCalledTimes(2);
  });

  it('rejects a second activate while already active', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' });
    const result = await h.orchestrator.activate({ userId: 'u2' });
    expect(result.rejection).toBe('ALREADY_ACTIVE');
    expect(h.flowsheet.join).toHaveBeenCalledTimes(1);
  });
});

describe('Orchestrator — restart recovery', () => {
  it('re-attaches to an existing show only when BS confirms on-air', async () => {
    const snapshot: Snapshot = {
      phase: 'ACTIVE',
      showId: 789,
      activatedBy: { source: 'virtual_switch', userId: 'u1', at: '2026-03-07T22:00:00.000Z' },
      lastBreakpointHour: 100,
    };
    const h = harness({ snapshot, isOnAir: true });
    await h.orchestrator.recover();
    const status = h.orchestrator.getStatus();
    expect(status.active).toBe(true);
    expect(status.showId).toBe(789);
    expect(h.flowsheet.join).not.toHaveBeenCalled(); // no duplicate join
    expect(h.arduino.send).toHaveBeenCalledWith('resume'); // relay re-asserted on re-attach
  });

  it('restores the persisted breakpoint hour on re-attach so the next hour still posts its breakpoint', async () => {
    // Last breakpoint posted at hour 100; the process restarts during hour 101,
    // before hour 101's breakpoint. Recovery must restore lastBreakpointHour from
    // the snapshot (100), not reset it to the current hour (101) — otherwise the
    // HOUR_TICK guard (epochHour <= lastBreakpointHour) treats hour 101 as
    // already-posted and silently skips the hourly breakpoint.
    const snapshot: Snapshot = {
      phase: 'ACTIVE',
      showId: 789,
      activatedBy: { source: 'virtual_switch', userId: 'u1', at: '2026-03-07T22:00:00.000Z' },
      lastBreakpointHour: 100,
    };
    const h = harness({ snapshot, isOnAir: true, startHourMs: 101 * HOUR });
    await h.orchestrator.recover();
    await h.orchestrator.hourTick(); // now = hour 101
    expect(h.flowsheet.addBreakpoint).toHaveBeenCalledTimes(1);
  });

  it('ends the orphan and settles inactive when an ACTIVE snapshot is malformed (no showId)', async () => {
    // A partial/older snapshot: phase ACTIVE but showId missing, so we can't
    // re-attach. Recovery must still probe BS and end any orphaned show rather
    // than ignore a possibly-live Auto-DJ show it can no longer identify.
    const snapshot = { phase: 'ACTIVE', lastBreakpointHour: 100 } as Snapshot;
    const h = harness({ snapshot, isOnAir: true });
    await h.orchestrator.recover();
    expect(h.flowsheet.isOnAir).toHaveBeenCalled();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // orphan torn down
    expect(h.orchestrator.getStatus().active).toBe(false); // settled INACTIVE
    expect(h.arduino.send).toHaveBeenCalledWith('pause');
  });

  it('stays inactive when the snapshot is active but BS reports off-air', async () => {
    const snapshot: Snapshot = { phase: 'ACTIVE', showId: 789, lastBreakpointHour: 100 };
    const h = harness({ snapshot, isOnAir: false });
    await h.orchestrator.recover();
    expect(h.orchestrator.getStatus().active).toBe(false);
  });

  it('re-attaches optimistically when the on-air probe throws (avoids orphaning a live show)', async () => {
    const snapshot: Snapshot = { phase: 'ACTIVE', showId: 789, lastBreakpointHour: 100 };
    const h = harness({ snapshot });
    h.flowsheet.isOnAir.mockRejectedValueOnce(new Error('transient BS error'));
    await h.orchestrator.recover();
    expect(h.orchestrator.getStatus().active).toBe(true); // trusts the snapshot
    expect(h.flowsheet.join).not.toHaveBeenCalled();
  });

  it('finishes an interrupted deactivation on recovery instead of re-activating', async () => {
    const snapshot: Snapshot = { phase: 'DEACTIVATING', showId: 789, lastBreakpointHour: 100 };
    const h = harness({ snapshot, isOnAir: true });
    await h.orchestrator.recover();
    expect(h.orchestrator.getStatus().active).toBe(false);
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // teardown finished
    expect(h.flowsheet.join).not.toHaveBeenCalled(); // NOT re-activated
  });

  it('does not re-post the still-playing track after re-attaching on restart', async () => {
    const snapshot: Snapshot = {
      phase: 'ACTIVE',
      showId: 789,
      lastBreakpointHour: 100,
      lastPostedShId: 555, // the track playing (and already posted) before the restart
    };
    const h = harness({ snapshot, isOnAir: true });
    await h.orchestrator.recover();
    await h.orchestrator.onTrack(track(555)); // subscriber's first poll: same song still playing
    expect(h.flowsheet.addEntry).not.toHaveBeenCalled(); // dedupe key survived the restart
    await h.orchestrator.onTrack(track(556)); // a genuinely new track still posts
    expect(h.flowsheet.addEntry).toHaveBeenCalledWith(track(556));
  });

  it('does not durably record a failed entry as posted, so the track is retried after a restart', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' });
    const persistedShId = () => {
      const calls = h.stateStore.save.mock.calls;
      return (calls[calls.length - 1]![0] as Snapshot).lastPostedShId;
    };
    const beforeShId = persistedShId();

    // A genuinely new track fails to post to BS.
    h.flowsheet.addEntry.mockRejectedValueOnce(new Error('BS 500'));
    await h.orchestrator.onTrack(track(900));
    expect(h.flowsheet.addEntry).toHaveBeenCalledWith(track(900));
    // The snapshot must NOT claim sh_id 900 as posted — otherwise a restart would
    // dedupe it and drop the never-posted track forever.
    expect(persistedShId()).toBe(beforeShId);
    expect(persistedShId()).not.toBe(900);

    // The next track posts and IS durably recorded.
    await h.orchestrator.onTrack(track(901));
    expect(h.flowsheet.addEntry).toHaveBeenCalledWith(track(901));
    expect(persistedShId()).toBe(901);
  });

  it('ends an orphaned show and stays inactive when an interrupted activation is recovered', async () => {
    // Crashed mid-join: ACTIVATING persisted, but the show id was never learned.
    const snapshot: Snapshot = { phase: 'ACTIVATING' };
    const h = harness({ snapshot, isOnAir: true }); // BS reports on-air => our join created an orphan
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // orphan torn down
    expect(h.arduino.send).toHaveBeenCalledWith('pause'); // relay paused after teardown
    expect(h.flowsheet.join).not.toHaveBeenCalled(); // NOT auto-resurrected
    expect(h.orchestrator.getStatus().active).toBe(false);
  });

  it('stays inactive without ending anything when an interrupted activation created no show', async () => {
    const snapshot: Snapshot = { phase: 'ACTIVATING' };
    const h = harness({ snapshot, isOnAir: false }); // join never reached BS
    await h.orchestrator.recover();
    expect(h.flowsheet.end).not.toHaveBeenCalled();
    expect(h.orchestrator.getStatus().active).toBe(false);
  });

  it('persists the transitional phase before the network call so a crash mid-flight is recoverable', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' });
    // ACTIVATING is persisted via the strict (gating) save before flowsheet.join().
    const activatePhases = h.stateStore.saveStrict.mock.calls.map((c) => (c[0] as Snapshot).phase);
    expect(activatePhases).toContain('ACTIVATING');
    await h.orchestrator.deactivate();
    const deactivatePhases = h.stateStore.save.mock.calls.map((c) => (c[0] as Snapshot).phase);
    expect(deactivatePhases).toContain('DEACTIVATING'); // durable before flowsheet.end()
  });

  const lastSavedPhase = (h: ReturnType<typeof harness>) =>
    (h.stateStore.save.mock.calls.at(-1)?.[0] as Snapshot | undefined)?.phase;

  it('ends an orphan and settles inactive when the snapshot is corrupt (a show may be on air)', async () => {
    const h = harness({ isOnAir: true });
    h.stateStore.load.mockRejectedValueOnce(new Error('corrupt snapshot'));
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // corrupt != "no snapshot": probe + end
    expect(h.arduino.send).toHaveBeenCalledWith('pause'); // relay must not be left live
    expect(h.orchestrator.getStatus().active).toBe(false);
    expect(lastSavedPhase(h)).toBe('INACTIVE'); // converged
  });

  it('settles inactive without ending anything when a corrupt snapshot has no show on air', async () => {
    const h = harness({ isOnAir: false });
    h.stateStore.load.mockRejectedValueOnce(new Error('corrupt snapshot'));
    await h.orchestrator.recover();
    expect(h.flowsheet.end).not.toHaveBeenCalled();
    expect(h.orchestrator.getStatus().active).toBe(false);
    expect(lastSavedPhase(h)).toBe('INACTIVE');
  });

  it('does not end blind or converge when an interrupted-activation probe is indeterminate', async () => {
    const h = harness({ snapshot: { phase: 'ACTIVATING' } });
    h.flowsheet.isOnAir.mockRejectedValue(new Error('transient BS error')); // stays down
    await h.orchestrator.recover();
    expect(h.flowsheet.end).not.toHaveBeenCalled(); // ending blind could hit a human DJ's show
    expect(h.orchestrator.getStatus().active).toBe(false);
    // Must NOT persist INACTIVE — that would abandon a possible orphan and stop the
    // next boot from re-probing. The ACTIVATING snapshot is left for retry.
    expect(h.stateStore.save).not.toHaveBeenCalled();
    await h.orchestrator.recover(); // re-probes on the next boot
    expect(h.flowsheet.isOnAir).toHaveBeenCalledTimes(2);
  });

  it('does not converge when an interrupted deactivation cannot end the show (retries next boot)', async () => {
    const h = harness({ snapshot: { phase: 'DEACTIVATING', showId: 789 }, isOnAir: true });
    h.flowsheet.end.mockRejectedValue(new Error('BS down'));
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1);
    // end() failed -> the show may still be live -> must NOT durably record INACTIVE.
    const settled = h.stateStore.save.mock.calls.some(
      (c) => (c[0] as Snapshot).phase === 'INACTIVE',
    );
    expect(settled).toBe(false);
    await h.orchestrator.recover(); // DEACTIVATING snapshot survived -> retries end()
    expect(h.flowsheet.end).toHaveBeenCalledTimes(2);
  });

  it('does not converge when ending a confirmed orphan fails (retries next boot)', async () => {
    const h = harness({ snapshot: { phase: 'ACTIVATING' }, isOnAir: true });
    h.flowsheet.end.mockRejectedValue(new Error('BS down'));
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // positive probe -> tried to end
    const settled = h.stateStore.save.mock.calls.some(
      (c) => (c[0] as Snapshot).phase === 'INACTIVE',
    );
    expect(settled).toBe(false);
    await h.orchestrator.recover(); // ACTIVATING snapshot survived -> re-probes + retries
    expect(h.flowsheet.end).toHaveBeenCalledTimes(2);
  });

  it('pauses the relay and settles inactive when finishing an interrupted deactivation', async () => {
    const h = harness({ snapshot: { phase: 'DEACTIVATING', showId: 789 }, isOnAir: true });
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1);
    expect(h.arduino.send).toHaveBeenCalledWith('pause'); // relay was left in 'resume'
    expect(lastSavedPhase(h)).toBe('INACTIVE'); // converged
  });

  it('recovery is terminal: a second recover() after an interrupted deactivation does not re-end', async () => {
    const h = harness({ snapshot: { phase: 'DEACTIVATING', showId: 789 }, isOnAir: true });
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1);
    await h.orchestrator.recover(); // snapshot is now INACTIVE; must be a no-op
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // not re-ended every boot
  });

  it('interrupted-activation recovery settles inactive so a second recover() does not re-end', async () => {
    const h = harness({ snapshot: { phase: 'ACTIVATING' }, isOnAir: true });
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1);
    expect(lastSavedPhase(h)).toBe('INACTIVE');
    await h.orchestrator.recover();
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // idempotent-terminal
  });

  it('does not create a BS show when the activation-intent persist fails', async () => {
    const h = harness();
    h.stateStore.saveStrict.mockRejectedValueOnce(new Error('disk full'));
    await h.orchestrator.activate({ userId: 'u1' });
    expect(h.flowsheet.join).not.toHaveBeenCalled(); // gated: no durable intent -> no join
    expect(h.orchestrator.getStatus().active).toBe(false); // rolled back
    expect(h.arduino.send).toHaveBeenCalledWith('pause');
  });
});

describe('Orchestrator — opening entry + breakpoint retry', () => {
  it('posts the currently-playing track as the show opening entry on activate', async () => {
    const opening = track(42);
    const h = harness({ currentTrack: opening });
    await h.orchestrator.activate({ userId: 'u1' });
    expect(h.flowsheet.addEntry).toHaveBeenCalledWith(opening);
  });

  it('does not double-post the opening track when a same-sh_id now-playing callback races in', async () => {
    const opening = track(42);
    const h = harness({ currentTrack: opening });
    await h.orchestrator.activate({ userId: 'u1' }); // posts opening (sh_id 42)
    await h.orchestrator.onTrack(track(42)); // the subscriber callback for the same track
    expect(h.flowsheet.addEntry).toHaveBeenCalledTimes(1);
  });

  it('retries the hourly breakpoint after a transient failure instead of skipping the hour', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' }); // seeds lastBreakpointHour = 100
    h.setNow(101 * HOUR);
    h.flowsheet.addBreakpoint.mockRejectedValueOnce(new Error('transient'));
    await h.orchestrator.hourTick(); // fails — hour NOT marked posted
    expect(h.flowsheet.addBreakpoint).toHaveBeenCalledTimes(1);
    await h.orchestrator.hourTick(); // retries the same hour
    expect(h.flowsheet.addBreakpoint).toHaveBeenCalledTimes(2);
  });
});

describe('Orchestrator — failure handling', () => {
  it('rolls back to INACTIVE and pauses the Arduino when the show start fails', async () => {
    const h = harness();
    h.flowsheet.join.mockRejectedValueOnce(new Error('BS down'));
    await h.orchestrator.activate({ userId: 'u1' });
    expect(h.orchestrator.getStatus().active).toBe(false);
    // The rest of the activate batch is abandoned: no 'resume', and a pause is sent.
    expect(h.arduino.send).not.toHaveBeenCalledWith('resume');
    expect(h.arduino.send).toHaveBeenCalledWith('pause');
  });

  it('stays DEACTIVATING (does not orphan) when flowsheet.end() fails, still surfacing the outcome', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' });
    h.stateStore.save.mockClear();
    h.flowsheet.end.mockRejectedValueOnce(new Error('BS down'));
    const result = await h.orchestrator.deactivate();
    // item 1 (R2): end() threw, so the show is STILL LIVE in BS. SHOW_ENDED is not
    // dispatched — the phase stays DEACTIVATING durably, the reconciler (item 4)
    // retries end() and converges only when the probe confirms off-air. The failed
    // teardown is still reported so the router answers 502 (unchanged from #20).
    expect(result.failedEffect).toBe('END_SHOW');
    // item 6: DEACTIVATING counts as on-air, so status reads "teardown pending",
    // not a lie that the (still-live) show is off.
    expect(h.orchestrator.getStatus().active).toBe(true);
    // The relay is paused regardless (safe hardware state), but the snapshot must
    // NOT be INACTIVE — a durable INACTIVE over a live show is the orphan bug.
    expect(h.arduino.send).toHaveBeenCalledWith('pause');
    const savedPhases = h.stateStore.save.mock.calls.map((c) => (c[0] as Snapshot).phase);
    expect(savedPhases).not.toContain('INACTIVE');
    expect(savedPhases).toContain('DEACTIVATING');
  });

  it('reports no failedEffect on a clean deactivation', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' });
    const result = await h.orchestrator.deactivate();
    expect(result.failedEffect).toBeUndefined();
    expect(h.orchestrator.getStatus().active).toBe(false);
  });
});
