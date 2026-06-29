/**
 * Pure activation reducer — the orchestrator's brain.
 *
 * `reduce(state, event)` returns the next state plus a list of side `effects`
 * for the impure coordinator to execute, and an optional `rejection` the HTTP
 * layer maps to a 4xx. No I/O, no wall-clock: every event carries the `at` /
 * `epochHour` it needs, so the function is deterministic and fully testable.
 *
 * Conflict rules (networking-spec §2.7):
 *   1. Live DJ always wins — a live-DJ relay/is_live signal deactivates auto-DJ
 *      regardless of how it was activated (`deactivatedBy.source = 'relay'`).
 *   2. Button ≡ virtual switch, last action wins.
 *   3. No auto-reactivation — when the live DJ clears, auto-DJ stays off until a
 *      human re-activates via the button or the virtual switch.
 */
import type { Activation, ActivationState, NowPlaying } from './state.js';

export type Event =
  | {
      kind: 'ACTIVATE_REQUESTED';
      source: 'virtual_switch' | 'button';
      userId?: string;
      userName?: string;
      at: string;
    }
  | { kind: 'DEACTIVATE_REQUESTED'; source: 'virtual_switch' | 'button'; at: string }
  | { kind: 'BUTTON_TOGGLED'; at: string }
  | { kind: 'RELAY_STATE'; isLive: boolean; at: string }
  | { kind: 'NOW_PLAYING'; track: NowPlaying; at: string }
  | { kind: 'SHOW_STARTED'; showId: number; epochHour: number }
  | { kind: 'SHOW_ENDED' }
  | { kind: 'HOUR_TICK'; epochHour: number }
  | { kind: 'RECOVERED'; showId: number; activatedBy: Activation; epochHour: number };

export type Effect =
  | { type: 'START_SHOW' }
  | { type: 'END_SHOW' }
  | { type: 'POST_ENTRY'; track: NowPlaying }
  | { type: 'POST_BREAKPOINT' }
  | { type: 'SUBSCRIBE_AZURACAST' }
  | { type: 'UNSUBSCRIBE_AZURACAST' }
  | { type: 'SEND_ARDUINO_COMMAND'; action: 'pause' | 'resume' }
  | { type: 'PERSIST_STATE' };

export type RejectionCode = 'ALREADY_ACTIVE' | 'LIVE_DJ' | 'NOT_ACTIVE';

export interface ReduceResult {
  state: ActivationState;
  effects: Effect[];
  /** Set when the event was refused; the state is unchanged in that case. */
  rejection?: RejectionCode;
}

const reject = (state: ActivationState, rejection: RejectionCode): ReduceResult => ({
  state,
  effects: [],
  rejection,
});

/** Effects emitted when auto-DJ turns on. */
const ACTIVATE_EFFECTS: Effect[] = [
  { type: 'START_SHOW' },
  { type: 'SUBSCRIBE_AZURACAST' },
  { type: 'SEND_ARDUINO_COMMAND', action: 'resume' },
  { type: 'PERSIST_STATE' },
];

/** Effects emitted when auto-DJ turns off. */
const DEACTIVATE_EFFECTS: Effect[] = [
  { type: 'END_SHOW' },
  { type: 'UNSUBSCRIBE_AZURACAST' },
  { type: 'SEND_ARDUINO_COMMAND', action: 'pause' },
  { type: 'PERSIST_STATE' },
];

function activate(state: ActivationState, activatedBy: Activation): ReduceResult {
  if (state.liveDj) return reject(state, 'LIVE_DJ');
  return {
    state: { ...state, phase: 'ACTIVATING', activatedBy, currentTrack: null },
    effects: ACTIVATE_EFFECTS,
  };
}

function deactivate(state: ActivationState, deactivatedBy: Activation): ReduceResult {
  return {
    state: {
      ...state,
      phase: 'DEACTIVATING',
      lastDeactivatedBy: deactivatedBy,
      activatedBy: undefined,
    },
    effects: DEACTIVATE_EFFECTS,
  };
}

export function reduce(state: ActivationState, event: Event): ReduceResult {
  switch (event.kind) {
    case 'ACTIVATE_REQUESTED': {
      if (state.phase !== 'INACTIVE') return reject(state, 'ALREADY_ACTIVE');
      return activate(state, {
        source: event.source,
        userId: event.userId,
        userName: event.userName,
        at: event.at,
      });
    }

    case 'DEACTIVATE_REQUESTED': {
      if (state.phase !== 'ACTIVE' && state.phase !== 'ACTIVATING')
        return reject(state, 'NOT_ACTIVE');
      return deactivate(state, { source: event.source, at: event.at });
    }

    case 'BUTTON_TOGGLED': {
      // The button toggles: inactive -> activate, active -> deactivate. Last action wins.
      if (state.phase === 'INACTIVE') return activate(state, { source: 'button', at: event.at });
      if (state.phase === 'ACTIVE' || state.phase === 'ACTIVATING') {
        return deactivate(state, { source: 'button', at: event.at });
      }
      return { state, effects: [] }; // mid-deactivation: ignore
    }

    case 'RELAY_STATE': {
      const liveDj = event.isLive;
      // Live DJ always wins: deactivate if we're on the air.
      if (liveDj && (state.phase === 'ACTIVE' || state.phase === 'ACTIVATING')) {
        const result = deactivate(
          { ...state, liveDj },
          { source: 'relay', detail: 'Live DJ detected', at: event.at },
        );
        return result;
      }
      // Otherwise just record the flag. No auto-reactivation when it clears.
      return { state: { ...state, liveDj }, effects: [] };
    }

    case 'NOW_PLAYING': {
      const detected: ActivationState['currentTrack'] = {
        artist: event.track.artist,
        title: event.track.title,
        album: event.track.album,
        detectedAt: event.at,
      };
      // Post entries only once the show exists. During ACTIVATING we remember the
      // track and post it on SHOW_STARTED so the first track isn't dropped.
      if (state.phase === 'ACTIVE') {
        return {
          state: { ...state, currentTrack: detected },
          effects: [{ type: 'POST_ENTRY', track: event.track }],
        };
      }
      if (state.phase === 'ACTIVATING') {
        return { state: { ...state, currentTrack: detected }, effects: [] };
      }
      return { state, effects: [] };
    }

    case 'SHOW_STARTED': {
      if (state.phase !== 'ACTIVATING') return { state, effects: [] };
      const effects: Effect[] = [{ type: 'PERSIST_STATE' }];
      // Flush a track that arrived during activation.
      if (state.currentTrack) {
        effects.unshift({
          type: 'POST_ENTRY',
          track: {
            shId: 0,
            artist: state.currentTrack.artist,
            title: state.currentTrack.title,
            album: state.currentTrack.album,
            isLive: false,
          },
        });
      }
      return {
        state: {
          ...state,
          phase: 'ACTIVE',
          showId: event.showId,
          lastBreakpointHour: event.epochHour,
        },
        effects,
      };
    }

    case 'SHOW_ENDED': {
      if (state.phase !== 'DEACTIVATING') return { state, effects: [] };
      return {
        state: {
          ...state,
          phase: 'INACTIVE',
          showId: undefined,
          currentTrack: null,
          lastBreakpointHour: undefined,
        },
        effects: [{ type: 'PERSIST_STATE' }],
      };
    }

    case 'HOUR_TICK': {
      if (state.phase !== 'ACTIVE') return { state, effects: [] };
      if (state.lastBreakpointHour !== undefined && event.epochHour <= state.lastBreakpointHour) {
        return { state, effects: [] };
      }
      return {
        state: { ...state, lastBreakpointHour: event.epochHour },
        effects: [{ type: 'POST_BREAKPOINT' }],
      };
    }

    case 'RECOVERED': {
      // Re-attach to an existing show after a restart. No START_SHOW (it exists).
      return {
        state: {
          ...state,
          phase: 'ACTIVE',
          showId: event.showId,
          activatedBy: event.activatedBy,
          lastBreakpointHour: event.epochHour,
          currentTrack: null,
        },
        effects: [{ type: 'SUBSCRIBE_AZURACAST' }],
      };
    }
  }
}
