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
  | { kind: 'ENTRY_POSTED'; shId: number }
  | { kind: 'BREAKPOINT_POSTED'; epochHour: number }
  | {
      kind: 'RECOVERED';
      showId: number;
      activatedBy: Activation;
      lastBreakpointHour: number;
      lastPostedShId?: number;
    };

export type Effect =
  | { type: 'START_SHOW' }
  | { type: 'END_SHOW' }
  | { type: 'POST_ENTRY'; track: NowPlaying }
  | { type: 'POST_BREAKPOINT'; epochHour: number }
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

// The AzuraCast subscriber runs continuously (boot to shutdown), so activation
// only gates *writes*; we no longer SUBSCRIBE/UNSUBSCRIBE per activation. This
// keeps the live-DJ (is_live) signal current even while auto-DJ is inactive, so
// `liveDj` can clear when a live DJ leaves.

// PERSIST_STATE comes FIRST so the transitional intent (ACTIVATING / DEACTIVATING)
// is durable before the killable network call: SHOW_STARTED / SHOW_ENDED overwrite
// it with the terminal phase on success, but a crash in between leaves the
// transitional phase on disk for recover() to clean up (an orphaned show start, or
// an interrupted teardown). With PERSIST last, only {ACTIVE, INACTIVE} ever reached
// disk, so a crash mid-deactivate re-attached (resurrected) the show and a crash
// mid-activate left an orphan BS show that recovery never probed.

/** Effects emitted when auto-DJ turns on. */
const ACTIVATE_EFFECTS: Effect[] = [
  { type: 'PERSIST_STATE' },
  { type: 'START_SHOW' },
  { type: 'SEND_ARDUINO_COMMAND', action: 'resume' },
];

/** Effects emitted when auto-DJ turns off. */
const DEACTIVATE_EFFECTS: Effect[] = [
  { type: 'PERSIST_STATE' },
  { type: 'END_SHOW' },
  { type: 'SEND_ARDUINO_COMMAND', action: 'pause' },
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
      // Post entries only once the show exists. The opening entry of a new show
      // is posted by the coordinator (which feeds the current track on
      // SHOW_STARTED), so ACTIVATING only records the track for status display.
      if (state.phase === 'ACTIVE') {
        // Dedupe by sh_id: the coordinator's opening-entry post and a now-playing
        // callback that raced in during flowsheet.join() can carry the same track.
        if (state.lastPostedShId === event.track.shId) {
          return { state: { ...state, currentTrack: detected }, effects: [] };
        }
        // Advance lastPostedShId in memory now so a same-sh_id callback that
        // races in during the post is deduped, but do NOT persist here: the
        // snapshot's dedupe key must only ever record a track that BS actually
        // accepted. If addEntry() fails, PERSIST is skipped (see ENTRY_POSTED),
        // so a restart re-attempts the entry instead of the snapshot claiming a
        // never-posted track as already posted and dropping it forever.
        return {
          state: { ...state, currentTrack: detected, lastPostedShId: event.track.shId },
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
      return {
        state: {
          ...state,
          phase: 'ACTIVE',
          showId: event.showId,
          lastBreakpointHour: event.epochHour,
          lastPostedShId: undefined, // fresh show: let the opening entry post
        },
        // No PERSIST_STATE (item 3): the orchestrator owns the single post-join
        // saveStrict(ACTIVE+id). Reaching ACTIVE through exactly one STRICT write
        // means ACTIVATING-on-disk always signifies "no confirmed show", so the
        // reconciler can end an on-air orphan without risk of tearing down a
        // healthy show whose best-effort ACTIVE persist merely dropped. Emitting a
        // best-effort PERSIST_STATE here would re-open that split brain.
        effects: [],
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
          lastPostedShId: undefined,
        },
        effects: [{ type: 'PERSIST_STATE' }],
      };
    }

    case 'HOUR_TICK': {
      if (state.phase !== 'ACTIVE') return { state, effects: [] };
      if (state.lastBreakpointHour !== undefined && event.epochHour <= state.lastBreakpointHour) {
        return { state, effects: [] };
      }
      // Do NOT advance lastBreakpointHour here — only after the post succeeds
      // (BREAKPOINT_POSTED). A transient failure then retries on the next tick
      // instead of permanently skipping the hour.
      return { state, effects: [{ type: 'POST_BREAKPOINT', epochHour: event.epochHour }] };
    }

    case 'ENTRY_POSTED': {
      // The coordinator dispatches this only after flowsheet.addEntry() succeeds.
      // NOW_PLAYING already advanced lastPostedShId in memory (for same-sh_id
      // dedupe); persisting here — and only here — keeps the durable dedupe key
      // limited to entries BS actually accepted, so a crashed post is retried
      // after a restart rather than silently dropped. Persist only if the
      // confirmed sh_id is still the current dedupe key, so a late confirmation
      // can't durably record a key the live state has already moved past.
      if (state.phase !== 'ACTIVE' || state.lastPostedShId !== event.shId) {
        return { state, effects: [] };
      }
      return { state, effects: [{ type: 'PERSIST_STATE' }] };
    }

    case 'BREAKPOINT_POSTED': {
      if (state.phase !== 'ACTIVE') return { state, effects: [] };
      if (state.lastBreakpointHour !== undefined && event.epochHour <= state.lastBreakpointHour) {
        return { state, effects: [] };
      }
      return { state: { ...state, lastBreakpointHour: event.epochHour }, effects: [] };
    }

    case 'RECOVERED': {
      // Re-attach to an existing show after a restart. No START_SHOW (it exists);
      // the subscriber already runs continuously, so no SUBSCRIBE either. Guard on
      // INACTIVE (like SHOW_STARTED guards ACTIVATING, SHOW_ENDED guards DEACTIVATING):
      // a RECOVERED that arrives after the machine has already activated a NEW show —
      // e.g. a stale item-8 reconfirm — must not clobber the live show's id/watermarks.
      if (state.phase !== 'INACTIVE') return { state, effects: [] };
      return {
        state: {
          ...state,
          phase: 'ACTIVE',
          showId: event.showId,
          activatedBy: event.activatedBy,
          lastBreakpointHour: event.lastBreakpointHour,
          currentTrack: null,
          lastPostedShId: event.lastPostedShId,
        },
        effects: [{ type: 'PERSIST_STATE' }],
      };
    }
  }
}
