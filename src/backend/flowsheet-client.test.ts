/**
 * `join()` response-shape handling, and the `intent` / `expected_show_id`
 * takeover handshake (WXYC/wxyc-shared#415, WXYC/auto-dj-orchestrator#36).
 *
 * BS `POST /flowsheet/join` answers with one of two shapes at HTTP 200: a
 * `Show` (new show started, has `id`) or a `ShowDJ` (the caller was added to —
 * or was already on — an already-open show, which carries `show_id` and has no
 * `id` column at all). While `FLOWSHEET_TAKEOVER_ENABLED` is off, or while no
 * other show is open, that is the whole story.
 *
 * Once the flag is on, an open show the caller isn't a member of answers 409
 * (`ShowAlreadyOpenError`, `code: show_already_open`) unless the caller sends
 * an explicit `intent`. `join()`'s first attempt sends none — the wire
 * contract reserves that for "the caller hasn't chosen yet", which is exactly
 * true of Auto-DJ before it knows a collision exists — so a 409 there is the
 * discovery signal, not a hand-picked default. See #32.
 */
import { describe, it, expect, vi } from 'vitest';
import { FlowsheetClient } from './flowsheet-client.js';
import type { Logger } from '../logger.js';
import type { TokenManager } from './token-manager.js';

const tokenManager = {
  getUserId: async () => 'auto-dj-user-id',
  getToken: async () => 'jwt',
  refresh: async () => 'jwt-refreshed',
} as unknown as TokenManager;

interface MockResponse {
  status: number;
  body: unknown;
}

function fetchReturning(...responses: MockResponse[]) {
  const fetchFn = vi.fn();
  for (const r of responses) {
    fetchFn.mockImplementationOnce(async () => ({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body),
    }));
  }
  return fetchFn as unknown as typeof fetch;
}

// Mirrors `fakeLogger()` in state-store.test.ts; the client only ever reaches
// for `info` and `warn`.
const loggerSpy = () => ({ info: vi.fn(), warn: vi.fn() });

function clientWith(fetchFn: typeof fetch, logger?: ReturnType<typeof loggerSpy>) {
  return new FlowsheetClient({
    backendUrl: 'http://backend:8080',
    showName: 'Auto DJ',
    tokenManager,
    fetchFn,
    logger: logger as unknown as Logger,
  });
}

function clientReturning(payload: unknown) {
  return clientWith(fetchReturning({ status: 200, body: payload }));
}

function requestBody(fetchFn: typeof fetch, callIndex: number): Record<string, unknown> {
  const call = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[callIndex];
  const init = call[1] as { body?: string };
  return init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
}

const showAlreadyOpen = (showId: number) => ({
  status: 409,
  body: {
    message: 'A show is already on air',
    code: 'show_already_open',
    details: { show: { id: showId, dj_name: 'dj who left', start_time: '2026-08-20T10:00:00Z' } },
  },
});

describe('FlowsheetClient.join()', () => {
  it('returns the id from a Show-shaped response (new show started)', async () => {
    await expect(clientReturning({ id: 1947047 }).join()).resolves.toBe(1947047);
  });

  it('returns show_id from a ShowDJ-shaped response instead of throwing', async () => {
    // The exact body BS returned in staging on 2026-08-26 (#32).
    const showDj = { show_id: 1947044, dj_id: 'auto-dj-user-id', active: true };
    await expect(clientReturning(showDj).join()).resolves.toBe(1947044);
  });

  it('throws when the response carries neither id nor show_id', async () => {
    await expect(clientReturning({ unexpected: true }).join()).rejects.toThrow(
      'returned no show id',
    );
  });

  it('sends no intent on the discovery attempt (clean start)', async () => {
    const fetchFn = fetchReturning({ status: 200, body: { id: 1947047 } });
    await clientWith(fetchFn).join();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = requestBody(fetchFn, 0);
    expect(body.dj_id).toBe('auto-dj-user-id');
    expect(body).not.toHaveProperty('intent');
    expect(body).not.toHaveProperty('expected_show_id');
  });

  it('takes over an abandoned show after a 409, echoing details.show.id as expected_show_id', async () => {
    const fetchFn = fetchReturning(showAlreadyOpen(555), { status: 200, body: { id: 999 } });
    await expect(clientWith(fetchFn).join()).resolves.toBe(999);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const retryBody = requestBody(fetchFn, 1);
    expect(retryBody.intent).toBe('takeover');
    expect(retryBody.expected_show_id).toBe(555);
  });

  it('aborts rather than retrying a second time when the takeover is refused, naming both show ids', async () => {
    const fetchFn = fetchReturning(showAlreadyOpen(555), showAlreadyOpen(777));
    // Both ids, and no claim about which case it is — BS may reuse
    // `show_already_open` to refuse the very show we named.
    await expect(clientWith(fetchFn).join()).rejects.toThrow(/555[\s\S]*777/);
    // Bounded retry: exactly one takeover attempt, never a third call.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('warns instead of claiming a close when the takeover answers with a co-host membership', async () => {
    const logger = loggerSpy();
    const fetchFn = fetchReturning(showAlreadyOpen(555), {
      status: 200,
      body: { show_id: 555, dj_id: 'auto-dj-user-id', active: true },
    });

    await expect(clientWith(fetchFn, logger).join()).resolves.toBe(555);

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'auto-dj took over an abandoned show',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ showId: 555 }),
      expect.stringContaining('was not closed'),
    );
  });

  it('carries the status and body through when a 409 is not show_already_open', async () => {
    const fetchFn = fetchReturning({
      status: 409,
      body: { message: 'nope', code: 'some_future_code' },
    });
    // `allowStatuses` suppressed request()'s own error, so join() is the only
    // place this gets described — it must not be reported as a missing id alone.
    await expect(clientWith(fetchFn).join()).rejects.toThrow(/409[\s\S]*some_future_code/);
  });

  it('propagates a 400 rejecting the takeover rather than swallowing it', async () => {
    const fetchFn = fetchReturning(showAlreadyOpen(555), {
      status: 400,
      body: { message: 'Bad Request: intent "takeover" requires expected_show_id' },
    });
    await expect(clientWith(fetchFn).join()).rejects.toThrow(/400/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws rather than retrying when the 409 body carries no details.show.id', async () => {
    const fetchFn = fetchReturning({
      status: 409,
      body: { message: 'A show is already on air', code: 'show_already_open' },
    });
    await expect(clientWith(fetchFn).join()).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
