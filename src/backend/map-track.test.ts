import { describe, it, expect } from 'vitest';
import { mapTrackToEntry, breakpointBody } from './map-track.js';

describe('mapTrackToEntry', () => {
  it('maps an AzuraCast track to the BS freeform-entry body', () => {
    expect(
      mapTrackToEntry({
        shId: 1,
        artist: 'Jessica Pratt',
        title: 'Back, Baby',
        album: 'On Your Own Love Again',
        isLive: false,
      }),
    ).toEqual({
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      track_title: 'Back, Baby',
      record_label: '',
      request_flag: false,
    });
  });

  it('passes empty fields through (no nulls)', () => {
    expect(mapTrackToEntry({ shId: 2, artist: '', title: '', album: '', isLive: false })).toEqual({
      artist_name: '',
      album_title: '',
      track_title: '',
      record_label: '',
      request_flag: false,
    });
  });
});

describe('breakpointBody', () => {
  it('is a BREAKPOINT message entry', () => {
    expect(breakpointBody()).toEqual({ message: 'BREAKPOINT' });
  });
});
