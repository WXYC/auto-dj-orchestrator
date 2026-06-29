/**
 * Drives a real AzuraCastSubscriber against an inline, controllable now-playing
 * server (the same shape as test/mocks/azuracast-mock) over the HTTP poll path,
 * and asserts a driven track change is emitted as an sh_id-deduped onTrack. The
 * Centrifugo WS is pointed at a refused port so the subscriber degrades to
 * polling — exactly the staging-mock behavior. (The track -> flowsheet-entry leg
 * is covered by src/core/orchestrator.test.ts.)
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AzuraCastSubscriber } from './subscriber.js';
import type { NowPlaying } from '../core/state.js';

let nowPlaying = {
  sh_id: 1,
  song: { artist: 'Juana Molina', title: 'la paradoja', album: 'DOGA' },
  is_live: false,
};

function startNowPlaying(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/np')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          now_playing: { sh_id: nowPlaying.sh_id, song: nowPlaying.song },
          live: { is_live: nowPlaying.is_live },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({ server, url: `http://localhost:${(server.address() as AddressInfo).port}/np` }),
    ),
  );
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

describe('AzuraCastSubscriber live poll (drivable mock)', () => {
  let np: Awaited<ReturnType<typeof startNowPlaying>>;
  let sub: AzuraCastSubscriber;

  beforeEach(async () => {
    nowPlaying = {
      sh_id: 1,
      song: { artist: 'Juana Molina', title: 'la paradoja', album: 'DOGA' },
      is_live: false,
    };
    np = await startNowPlaying();
  });

  afterEach(async () => {
    sub.stop();
    await new Promise<void>((r) => np.server.close(() => r()));
  });

  it('emits the current track on boot and again when the mock is driven to a new sh_id', async () => {
    const tracks: NowPlaying[] = [];
    sub = new AzuraCastSubscriber(
      {
        wsUrl: 'ws://127.0.0.1:1', // refused -> degrade to polling
        httpUrl: np.url,
        stationShortcode: 'wxyc',
        safetyPollMs: 40,
        fallbackPollMs: 40,
      },
      { onTrack: (t) => tracks.push(t), onLive: () => {} },
    );
    sub.start();

    await waitFor(() => tracks.length === 1);
    expect(tracks[0]).toMatchObject({ shId: 1, artist: 'Juana Molina', title: 'la paradoja' });

    // Drive a track change on the mock.
    nowPlaying = {
      sh_id: 2,
      song: { artist: 'Cat Power', title: 'Werewolf', album: 'You Are Free' },
      is_live: false,
    };
    await waitFor(() => tracks.length === 2);
    expect(tracks[1]).toMatchObject({ shId: 2, artist: 'Cat Power' });
  });
});
