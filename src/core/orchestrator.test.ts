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
});
