/**
 * `join()` response-shape handling.
 *
 * BS `POST /flowsheet/join` answers with one of two shapes at HTTP 200: a
 * `Show` (new show started, has `id`) or a `ShowDJ` (the caller was added to —
 * or was already on — an already-open show, which carries `show_id` and has no
 * `id` column at all). Auto-DJ meets the second shape whenever the most recent
 * show is still open. See #32.
 */
import { describe, it, expect, vi } from 'vitest';
import { FlowsheetClient } from './flowsheet-client.js';
import type { TokenManager } from './token-manager.js';

const tokenManager = {
  getUserId: async () => 'auto-dj-user-id',
  getToken: async () => 'jwt',
  refresh: async () => 'jwt-refreshed',
} as unknown as TokenManager;

function clientReturning(payload: unknown) {
  const fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
  return new FlowsheetClient({
    backendUrl: 'http://backend:8080',
    showName: 'Auto DJ',
    tokenManager,
    fetchFn,
  });
}

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
});
