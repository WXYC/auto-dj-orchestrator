import { describe, it, expect } from 'vitest';
import { reduce, type Event, type Effect } from './activation-state-machine.js';
import { initialState, type ActivationState, type NowPlaying } from './state.js';

const AT = '2026-03-07T22:15:00.000Z';
const track = (shId: number): NowPlaying => ({
  shId,
  artist: 'Juana Molina',
  title: 'la paradoja',
  album: 'DOGA',
  isLive: false,
});

const effectTypes = (effects: Effect[]) => effects.map((e) => e.type);

/** Drive the reducer through a sequence of events, returning the final state. */
function run(start: ActivationState, events: Event[]): ActivationState {
  return events.reduce((state, event) => reduce(state, event).state, start);
}

const activated = (): ActivationState =>
  run(initialState, [
    {
      kind: 'ACTIVATE_REQUESTED',
      source: 'virtual_switch',
      userId: 'u1',
      userName: 'DJ Moonbeam',
      at: AT,
    },
    { kind: 'SHOW_STARTED', showId: 789, epochHour: 100 },
  ]);

describe('reduce — activation', () => {
  it('virtual_switch activate from INACTIVE goes ACTIVATING and starts a show', () => {
    const { state, effects, rejection } = reduce(initialState, {
      kind: 'ACTIVATE_REQUESTED',
      source: 'virtual_switch',
      userId: 'u1',
      userName: 'DJ Moonbeam',
      at: AT,
    });
    expect(rejection).toBeUndefined();
    expect(state.phase).toBe('ACTIVATING');
    expect(state.activatedBy).toEqual({
      source: 'virtual_switch',
      userId: 'u1',
      userName: 'DJ Moonbeam',
      at: AT,
    });
    expect(effectTypes(effects)).toEqual(['START_SHOW', 'SEND_ARDUINO_COMMAND', 'PERSIST_STATE']);
  });

  it('SHOW_STARTED moves ACTIVATING -> ACTIVE and seeds the breakpoint hour', () => {
    const after = reduce(
      reduce(initialState, { kind: 'ACTIVATE_REQUESTED', source: 'virtual_switch', at: AT }).state,
      { kind: 'SHOW_STARTED', showId: 789, epochHour: 100 },
    );
    expect(after.state.phase).toBe('ACTIVE');
    expect(after.state.showId).toBe(789);
    expect(after.state.lastBreakpointHour).toBe(100);
  });

  it('rejects activate while a live DJ is on air (409 LIVE_DJ)', () => {
    const live = reduce(initialState, { kind: 'RELAY_STATE', isLive: true, at: AT }).state;
    const { state, rejection } = reduce(live, {
      kind: 'ACTIVATE_REQUESTED',
      source: 'virtual_switch',
      at: AT,
    });
    expect(rejection).toBe('LIVE_DJ');
    expect(state.phase).toBe('INACTIVE');
  });

  it('rejects activate when already active (409 ALREADY_ACTIVE)', () => {
    const { rejection } = reduce(activated(), {
      kind: 'ACTIVATE_REQUESTED',
      source: 'virtual_switch',
      at: AT,
    });
    expect(rejection).toBe('ALREADY_ACTIVE');
  });
});

describe('reduce — deactivation', () => {
  it('virtual_switch deactivate from ACTIVE goes DEACTIVATING and ends the show', () => {
    const { state, effects } = reduce(activated(), {
      kind: 'DEACTIVATE_REQUESTED',
      source: 'virtual_switch',
      at: AT,
    });
    expect(state.phase).toBe('DEACTIVATING');
    expect(state.lastDeactivatedBy).toEqual({ source: 'virtual_switch', at: AT });
    expect(state.activatedBy).toBeUndefined();
    expect(effectTypes(effects)).toEqual(['END_SHOW', 'SEND_ARDUINO_COMMAND', 'PERSIST_STATE']);
  });

  it('SHOW_ENDED moves DEACTIVATING -> INACTIVE and clears the show', () => {
    const deactivating = reduce(activated(), {
      kind: 'DEACTIVATE_REQUESTED',
      source: 'virtual_switch',
      at: AT,
    }).state;
    const ended = reduce(deactivating, { kind: 'SHOW_ENDED' });
    expect(ended.state.phase).toBe('INACTIVE');
    expect(ended.state.showId).toBeUndefined();
    expect(ended.state.lastBreakpointHour).toBeUndefined();
  });

  it('rejects deactivate when not active (409 NOT_ACTIVE)', () => {
    const { rejection } = reduce(initialState, {
      kind: 'DEACTIVATE_REQUESTED',
      source: 'virtual_switch',
      at: AT,
    });
    expect(rejection).toBe('NOT_ACTIVE');
  });
});

describe('reduce — conflict resolution (§2.7)', () => {
  it('live DJ always wins: relay isLive while ACTIVE force-deactivates with source=relay', () => {
    const { state, effects } = reduce(activated(), { kind: 'RELAY_STATE', isLive: true, at: AT });
    expect(state.phase).toBe('DEACTIVATING');
    expect(state.lastDeactivatedBy).toEqual({
      source: 'relay',
      detail: 'Live DJ detected',
      at: AT,
    });
    expect(state.liveDj).toBe(true);
    expect(effectTypes(effects)).toContain('END_SHOW');
  });

  it('no auto-reactivation: relay clearing does not turn auto-DJ back on', () => {
    // ACTIVE -> live DJ -> DEACTIVATING -> SHOW_ENDED -> INACTIVE, then relay clears.
    const afterClear = run(activated(), [
      { kind: 'RELAY_STATE', isLive: true, at: AT },
      { kind: 'SHOW_ENDED' },
      { kind: 'RELAY_STATE', isLive: false, at: AT },
    ]);
    expect(afterClear.phase).toBe('INACTIVE');
    expect(afterClear.liveDj).toBe(false);
  });

  it('button and virtual switch are equivalent: button toggles on from INACTIVE', () => {
    const { state, effects } = reduce(initialState, { kind: 'BUTTON_TOGGLED', at: AT });
    expect(state.phase).toBe('ACTIVATING');
    expect(state.activatedBy).toEqual({ source: 'button', at: AT });
    expect(effectTypes(effects)).toContain('START_SHOW');
  });

  it('button toggles off from ACTIVE', () => {
    const { state } = reduce(activated(), { kind: 'BUTTON_TOGGLED', at: AT });
    expect(state.phase).toBe('DEACTIVATING');
    expect(state.lastDeactivatedBy?.source).toBe('button');
  });

  it('button toggle is refused implicitly while a live DJ is on air (stays inactive)', () => {
    const live = reduce(initialState, { kind: 'RELAY_STATE', isLive: true, at: AT }).state;
    const { state, rejection } = reduce(live, { kind: 'BUTTON_TOGGLED', at: AT });
    expect(state.phase).toBe('INACTIVE');
    expect(rejection).toBe('LIVE_DJ');
  });
});

describe('reduce — track posting + breakpoints', () => {
  it('NOW_PLAYING while ACTIVE posts an entry and records the current track', () => {
    const { state, effects } = reduce(activated(), {
      kind: 'NOW_PLAYING',
      track: track(1),
      at: AT,
    });
    expect(effects).toEqual([{ type: 'POST_ENTRY', track: track(1) }]);
    expect(state.currentTrack).toEqual({
      artist: 'Juana Molina',
      title: 'la paradoja',
      album: 'DOGA',
      detectedAt: AT,
    });
  });

  it('dedupes consecutive NOW_PLAYING with the same sh_id (no double opening entry)', () => {
    const active = activated();
    const first = reduce(active, { kind: 'NOW_PLAYING', track: track(9), at: AT });
    expect(first.effects).toEqual([{ type: 'POST_ENTRY', track: track(9) }]);
    expect(reduce(first.state, { kind: 'NOW_PLAYING', track: track(9), at: AT }).effects).toEqual(
      [],
    );
    expect(reduce(first.state, { kind: 'NOW_PLAYING', track: track(10), at: AT }).effects).toEqual([
      { type: 'POST_ENTRY', track: track(10) },
    ]);
  });

  it('records a track during ACTIVATING for status without posting; SHOW_STARTED just persists', () => {
    const activating = reduce(initialState, {
      kind: 'ACTIVATE_REQUESTED',
      source: 'virtual_switch',
      at: AT,
    }).state;
    const buffered = reduce(activating, { kind: 'NOW_PLAYING', track: track(5), at: AT });
    expect(buffered.state.currentTrack?.title).toBe('la paradoja');
    expect(buffered.effects).toEqual([]); // no post while still ACTIVATING
    const started = reduce(buffered.state, { kind: 'SHOW_STARTED', showId: 1, epochHour: 100 });
    expect(effectTypes(started.effects)).toEqual(['PERSIST_STATE']);
  });

  it('HOUR_TICK emits a breakpoint but only advances the hour on BREAKPOINT_POSTED (retry-safe)', () => {
    const active = activated(); // lastBreakpointHour = 100
    expect(reduce(active, { kind: 'HOUR_TICK', epochHour: 100 }).effects).toEqual([]); // same hour

    const tick = reduce(active, { kind: 'HOUR_TICK', epochHour: 101 });
    expect(tick.effects).toEqual([{ type: 'POST_BREAKPOINT', epochHour: 101 }]);
    expect(tick.state.lastBreakpointHour).toBe(100); // NOT advanced yet

    // Until the post is confirmed, a re-tick still emits (a transient failure retries).
    expect(reduce(tick.state, { kind: 'HOUR_TICK', epochHour: 101 }).effects).toEqual([
      { type: 'POST_BREAKPOINT', epochHour: 101 },
    ]);

    // Confirmation advances the hour; further ticks for it are then suppressed.
    const posted = reduce(tick.state, { kind: 'BREAKPOINT_POSTED', epochHour: 101 });
    expect(posted.state.lastBreakpointHour).toBe(101);
    expect(reduce(posted.state, { kind: 'HOUR_TICK', epochHour: 101 }).effects).toEqual([]);
  });

  it('NOW_PLAYING and HOUR_TICK are no-ops while INACTIVE', () => {
    expect(reduce(initialState, { kind: 'NOW_PLAYING', track: track(1), at: AT }).effects).toEqual(
      [],
    );
    expect(reduce(initialState, { kind: 'HOUR_TICK', epochHour: 100 }).effects).toEqual([]);
  });
});

describe('reduce — restart recovery', () => {
  it('RECOVERED re-enters ACTIVE without starting a new show', () => {
    const { state, effects } = reduce(initialState, {
      kind: 'RECOVERED',
      showId: 789,
      activatedBy: { source: 'virtual_switch', userId: 'u1', at: AT },
      epochHour: 100,
    });
    expect(state.phase).toBe('ACTIVE');
    expect(state.showId).toBe(789);
    expect(state.lastBreakpointHour).toBe(100);
    expect(effectTypes(effects)).toEqual(['PERSIST_STATE']);
    expect(effectTypes(effects)).not.toContain('START_SHOW');
  });
});
