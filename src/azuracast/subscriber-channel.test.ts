/**
 * The Centrifugo channel is `station:<shortcode>`, where the shortcode is the
 * station's *shortcode* (`main`) and not its display name (`wxyc`). Getting it
 * wrong fails silently by design: the WS connects, no publication ever arrives,
 * and the subscriber degrades to HTTP polling (see the module doc in
 * `subscriber.ts`). Pin the exact channel string so a change to the template
 * literal has to be deliberate. See #33.
 */
import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const subscription = { on: vi.fn(), subscribe: vi.fn() };
  return { subscription, newSubscription: vi.fn(() => subscription) };
});

vi.mock('centrifuge', () => ({
  Centrifuge: vi.fn(() => ({
    newSubscription: mocks.newSubscription,
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

const { AzuraCastSubscriber } = await import('./subscriber.js');

describe('AzuraCastSubscriber Centrifugo channel', () => {
  it('subscribes to station:<shortcode>, not station:<station name>', () => {
    const sub = new AzuraCastSubscriber(
      {
        wsUrl: 'wss://example/ws',
        httpUrl: 'https://example/np.json',
        stationShortcode: 'main',
        safetyPollMs: 60_000,
        fallbackPollMs: 20_000,
        fetchFn: vi.fn() as unknown as typeof fetch,
      },
      { onTrack: () => undefined, onLive: () => undefined },
    );

    sub.start();
    try {
      expect(mocks.newSubscription).toHaveBeenCalledWith('station:main', { recoverable: true });
    } finally {
      sub.stop(); // clear the poll timer armed by start()
    }
  });
});
