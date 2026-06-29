/**
 * Pure AzuraCast now-playing parsing.
 *
 * Extracts the fields the orchestrator needs (sh_id, song artist/title/album,
 * live.is_live) from either the static HTTP endpoint payload
 * (`{ now_playing, live }`) or a Centrifugo publication (`{ np: { ... } }`).
 * networking-spec §3.2 / §3.9.
 */
import type { NowPlaying } from '../core/state.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Unwrap a Centrifugo `{ np: {...} }` envelope, or pass through a static `{ now_playing, live }`. */
function asNowPlayingObject(payload: unknown): Record<string, unknown> | null {
  const obj = asRecord(payload);
  if (!obj) return null;
  const np = asRecord(obj.np);
  if (np) return np;
  if ('now_playing' in obj) return obj;
  return null;
}

/** Returns the parsed track, or null if the payload has no usable `now_playing.sh_id`. */
export function extractNowPlaying(payload: unknown): NowPlaying | null {
  const np = asNowPlayingObject(payload);
  if (!np) return null;

  const nowPlaying = asRecord(np.now_playing);
  if (!nowPlaying || typeof nowPlaying.sh_id !== 'number') return null;

  const song = asRecord(nowPlaying.song) ?? {};
  const live = asRecord(np.live);

  return {
    shId: nowPlaying.sh_id,
    artist: asString(song.artist),
    title: asString(song.title),
    album: asString(song.album),
    isLive: Boolean(live?.is_live),
  };
}
