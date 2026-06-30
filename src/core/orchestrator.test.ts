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

function harness(opts?: { isOnAir?: boolean; snapshot?: Snapshot | null; startHourMs?: number }) {
  let nowMs = opts?.startHourMs ?? 100 * HOUR;
  let nextShowId = 700;
  const flowsheet = {
    join: vi.fn(async () => ++nextShowId),
    end: vi.fn(async () => {}),
    addEntry: vi.fn(async () => {}),
    addBreakpoint: vi.fn(async () => {}),
    isOnAir: vi.fn(async () => opts?.isOnAir ?? false),
  };
  const azuracast = { start: vi.fn(), stop: vi.fn() } satisfies AzuraCastSource;
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
    expect(h.azuracast.start).toHaveBeenCalled();
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
  it('a live DJ preempts auto-DJ and there is no auto-reactivation', async () => {
    const h = harness();
    await h.orchestrator.activate({ userId: 'u1' });
    await h.orchestrator.relayState(true); // live DJ on air
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1);
    expect(h.azuracast.stop).toHaveBeenCalled();
    const status = h.orchestrator.getStatus();
    expect(status.active).toBe(false);
    expect(status.lastDeactivatedBy).toEqual({ source: 'relay', detail: 'Live DJ detected' });

    await h.orchestrator.relayState(false); // live DJ leaves
    expect(h.orchestrator.getStatus().active).toBe(false); // stays off
    expect(h.flowsheet.join).toHaveBeenCalledTimes(1); // never re-joined
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
    expect(h.azuracast.start).toHaveBeenCalled();
  });

  it('stays inactive when the snapshot is active but BS reports off-air', async () => {
    const snapshot: Snapshot = { phase: 'ACTIVE', showId: 789, lastBreakpointHour: 100 };
    const h = harness({ snapshot, isOnAir: false });
    await h.orchestrator.recover();
    expect(h.orchestrator.getStatus().active).toBe(false);
    expect(h.azuracast.start).not.toHaveBeenCalled();
  });

  it('finishes an interrupted deactivation on recovery instead of re-activating', async () => {
    const snapshot: Snapshot = { phase: 'DEACTIVATING', showId: 789, lastBreakpointHour: 100 };
    const h = harness({ snapshot, isOnAir: true });
    await h.orchestrator.recover();
    expect(h.orchestrator.getStatus().active).toBe(false);
    expect(h.flowsheet.end).toHaveBeenCalledTimes(1); // teardown finished
    expect(h.flowsheet.join).not.toHaveBeenCalled(); // NOT re-activated
    expect(h.azuracast.start).not.toHaveBeenCalled();
  });
});

describe('Orchestrator — failure handling', () => {
  it('rolls back to INACTIVE and pauses the Arduino when the show start fails', async () => {
    const h = harness();
    h.flowsheet.join.mockRejectedValueOnce(new Error('BS down'));
    await h.orchestrator.activate({ userId: 'u1' });
    expect(h.orchestrator.getStatus().active).toBe(false);
    // The rest of the activate batch is abandoned: no subscribe, no 'resume'.
    expect(h.azuracast.start).not.toHaveBeenCalled();
    expect(h.arduino.send).not.toHaveBeenCalledWith('resume');
    expect(h.arduino.send).toHaveBeenCalledWith('pause');
  });
});
