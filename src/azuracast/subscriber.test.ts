import { describe, it, expect, vi } from 'vitest';
import { AzuraCastSubscriber } from './subscriber.js';
import type { NowPlaying } from '../core/state.js';

function makeSubscriber() {
  const tracks: NowPlaying[] = [];
  const live: boolean[] = [];
  const sub = new AzuraCastSubscriber(
    {
      wsUrl: 'wss://example/ws',
      httpUrl: 'https://example/np.json',
      stationShortcode: 'wxyc',
      safetyPollMs: 60_000,
      fallbackPollMs: 20_000,
      // never actually connect during unit tests
      fetchFn: vi.fn() as unknown as typeof fetch,
    },
    { onTrack: (t) => tracks.push(t), onLive: (l) => live.push(l) },
  );
  return { sub, tracks, live };
}

const payload = (shId: number, isLive: boolean) => ({
  now_playing: {
    sh_id: shId,
    song: { artist: 'Stereolab', title: 'Brakhage', album: 'Dots and Loops' },
  },
  live: { is_live: isLive },
});

describe('AzuraCastSubscriber.ingest', () => {
  it('emits a track only when sh_id changes', () => {
    const { sub, tracks } = makeSubscriber();
    sub.ingest(payload(1, false));
    sub.ingest(payload(1, false)); // same sh_id -> no emit
    sub.ingest(payload(2, false));
    expect(tracks.map((t) => t.shId)).toEqual([1, 2]);
  });

  it('emits live transitions, including the initial state', () => {
    const { sub, live } = makeSubscriber();
    sub.ingest(payload(1, false)); // initial -> emit false
    sub.ingest(payload(2, false)); // unchanged -> no emit
    sub.ingest(payload(3, true)); // changed -> emit true
    expect(live).toEqual([false, true]);
  });

  it('ignores payloads with no usable now_playing', () => {
    const { sub, tracks, live } = makeSubscriber();
    sub.ingest({});
    sub.ingest(null);
    expect(tracks).toEqual([]);
    expect(live).toEqual([]);
  });

  it('re-emits the current track after stop() (dedupe state is reset for reuse)', () => {
    const { sub, tracks } = makeSubscriber();
    sub.ingest(payload(7, false));
    expect(tracks.map((t) => t.shId)).toEqual([7]);
    sub.stop(); // deactivate
    sub.ingest(payload(7, false)); // reactivate, same song still playing
    expect(tracks.map((t) => t.shId)).toEqual([7, 7]); // re-emitted, not suppressed
  });

  it('emits the live signal before the track on a single live-takeover payload', () => {
    const order: string[] = [];
    const sub = new AzuraCastSubscriber(
      {
        wsUrl: 'wss://example/ws',
        httpUrl: 'https://example/np.json',
        stationShortcode: 'wxyc',
        safetyPollMs: 60_000,
        fallbackPollMs: 20_000,
        fetchFn: vi.fn() as unknown as typeof fetch,
      },
      { onTrack: () => order.push('track'), onLive: () => order.push('live') },
    );
    sub.ingest(payload(1, false)); // seed: live=false, track 1
    sub.ingest(payload(2, true)); // takeover: new sh_id AND is_live in one payload
    expect(order).toEqual(['live', 'track', 'live', 'track']);
    // The second pair is live-then-track: deactivate is enqueued before the entry post.
  });
});
