/**
 * Activation domain model.
 *
 * The orchestrator's single source of truth for whether auto-DJ is on the air,
 * who turned it on/off, the current track, and the active show. Kept free of
 * I/O and wall-clock reads so the reducer (activation-state-machine.ts) is
 * exhaustively unit-testable — mirroring the Arduino firmware's pure-`tick()`
 * discipline.
 */

export type ActivationSourceType = 'virtual_switch' | 'button' | 'relay';

/** Who/what last flipped the switch, plus when. */
export interface Activation {
  source: ActivationSourceType;
  /** Better-Auth user id — only for `virtual_switch`. */
  userId?: string;
  /** Display name — only for `virtual_switch`. */
  userName?: string;
  /** Free-text context, e.g. "Live DJ detected" for `relay`. */
  detail?: string;
  /** ISO-8601 timestamp. */
  at: string;
}

/** A now-playing track as detected from AzuraCast (sh_id-deduped upstream). */
export interface NowPlaying {
  shId: number;
  artist: string;
  title: string;
  album: string;
  isLive: boolean;
}

export interface DetectedTrack {
  artist: string;
  title: string;
  album: string;
  /** ISO-8601 timestamp of when the orchestrator saw this track. */
  detectedAt: string;
}

export type Phase = 'INACTIVE' | 'ACTIVATING' | 'ACTIVE' | 'DEACTIVATING';

export interface ActivationState {
  phase: Phase;
  activatedBy?: Activation;
  lastDeactivatedBy?: Activation;
  showId?: number;
  currentTrack: DetectedTrack | null;
  /** epoch-hour index of the last posted breakpoint (undefined until a show starts). */
  lastBreakpointHour?: number;
  /** Last known live-DJ signal (relay open or AzuraCast is_live). */
  liveDj: boolean;
}

export const initialState: ActivationState = {
  phase: 'INACTIVE',
  currentTrack: null,
  liveDj: false,
};

/** True when auto-DJ is on the air (or in the brief activating/deactivating windows it is treated as "on"). */
export function isActive(state: ActivationState): boolean {
  return state.phase === 'ACTIVE' || state.phase === 'ACTIVATING';
}
