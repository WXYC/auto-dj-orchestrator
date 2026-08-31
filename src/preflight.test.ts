import { describe, it, expect, vi } from 'vitest';
import { runPreflight } from './preflight.js';
import type { Config } from './config.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const baseConfig = {
  AZURACAST_HTTP_URL: 'https://remote.wxyc.org/api/nowplaying_static/main.json',
  AZURACAST_STATION_SHORTCODE: 'main',
} as unknown as Config;

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('preflight', () => {
  it('passes when AzuraCast returns a single station object with matching shortcode', async () => {
    const fetchFn = mockFetch(200, { station: { shortcode: 'main' } });
    const result = await runPreflight(baseConfig, silentLogger, fetchFn);
    expect(result.azuracastShortcodeOk).toBe(true);
  });

  it('fails when AzuraCast returns the all-stations array (wrong shortcode)', async () => {
    const fetchFn = mockFetch(200, [
      { station: { shortcode: 'main' } },
      { station: { shortcode: 'other' } },
    ]);
    const result = await runPreflight(baseConfig, silentLogger, fetchFn);
    expect(result.azuracastShortcodeOk).toBe(false);
  });

  it('fails when the returned station shortcode does not match config', async () => {
    const fetchFn = mockFetch(200, { station: { shortcode: 'wxyc' } });
    const result = await runPreflight(baseConfig, silentLogger, fetchFn);
    expect(result.azuracastShortcodeOk).toBe(false);
  });

  it('fails on a non-200 response', async () => {
    const fetchFn = mockFetch(404, {});
    const result = await runPreflight(baseConfig, silentLogger, fetchFn);
    expect(result.azuracastShortcodeOk).toBe(false);
  });

  it('handles network errors without crashing', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await runPreflight(baseConfig, silentLogger, fetchFn);
    expect(result.azuracastShortcodeOk).toBe(false);
  });

  it('passes when station object has no shortcode field (graceful)', async () => {
    const fetchFn = mockFetch(200, { station: { name: 'WXYC' } });
    const result = await runPreflight(baseConfig, silentLogger, fetchFn);
    expect(result.azuracastShortcodeOk).toBe(true);
  });

  it('constructs the correct URL from AZURACAST_HTTP_URL origin + shortcode', async () => {
    const fetchFn = mockFetch(200, { station: { shortcode: 'main' } });
    await runPreflight(baseConfig, silentLogger, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://remote.wxyc.org/api/nowplaying/main',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
