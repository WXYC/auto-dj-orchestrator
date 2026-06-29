/**
 * Pure mapping from an AzuraCast track to a Backend-Service flowsheet entry body.
 *
 * Shape verified against BS `flowsheet.controller.ts` `FSEntryRequestBody`
 * (networking-spec §3.4.2). AzuraCast gives us no label, so `record_label` is "".
 */
import type { NowPlaying } from '../core/state.js';

export interface FlowsheetEntryBody {
  artist_name: string;
  album_title: string;
  track_title: string;
  record_label: string;
  request_flag: false;
}

export function mapTrackToEntry(track: NowPlaying): FlowsheetEntryBody {
  return {
    artist_name: track.artist,
    album_title: track.album,
    track_title: track.title,
    record_label: '',
    request_flag: false,
  };
}

/** Body for the top-of-hour breakpoint marker (BS does not auto-insert these). */
export function breakpointBody(): { message: string } {
  return { message: 'BREAKPOINT' };
}
