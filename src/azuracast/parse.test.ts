import { describe, it, expect } from 'vitest';
import { extractNowPlaying } from './parse.js';

const song = { artist: 'Juana Molina', title: 'la paradoja', album: 'DOGA' };

describe('extractNowPlaying', () => {
  it('parses the static HTTP payload shape', () => {
    const payload = { now_playing: { sh_id: 98765, song }, live: { is_live: false } };
    expect(extractNowPlaying(payload)).toEqual({
      shId: 98765,
      artist: 'Juana Molina',
      title: 'la paradoja',
      album: 'DOGA',
      isLive: false,
    });
  });

  it('parses the Centrifugo `{ np: {...} }` envelope identically', () => {
    const fromStatic = extractNowPlaying({
      now_playing: { sh_id: 1, song },
      live: { is_live: true },
    });
    const fromCentrifugo = extractNowPlaying({
      np: { now_playing: { sh_id: 1, song }, live: { is_live: true } },
    });
    expect(fromCentrifugo).toEqual(fromStatic);
    expect(fromCentrifugo?.isLive).toBe(true);
  });

  it('defaults missing song fields to empty strings', () => {
    const result = extractNowPlaying({ now_playing: { sh_id: 5, song: {} }, live: {} });
    expect(result).toEqual({ shId: 5, artist: '', title: '', album: '', isLive: false });
  });

  it('returns null when there is no usable now_playing.sh_id', () => {
    expect(extractNowPlaying({})).toBeNull();
    expect(extractNowPlaying({ now_playing: {} })).toBeNull();
    expect(extractNowPlaying(null)).toBeNull();
    expect(extractNowPlaying('nope')).toBeNull();
  });
});
