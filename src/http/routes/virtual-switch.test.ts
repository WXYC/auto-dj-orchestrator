/**
 * Virtual-switch router — POST /deactivate contract (#15 regression).
 *
 * Scoped to /deactivate: 200 on a clean teardown, 409 on NOT_ACTIVE, and 502
 * when the BS flowsheet.end() teardown failed. The 502 keys off the teardown
 * outcome the orchestrator reports (`deactivate().failedEffect === 'END_SHOW'`),
 * NOT getStatus().active — the machine converges to INACTIVE on a failed
 * teardown, so `active` is false on both success and failure (see #15). The
 * companion #16 coverage owns /status and /activate.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { virtualSwitchRouter } from './virtual-switch.js';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { AuthUser, JwtVerifier } from '../jwks-verifier.js';

const DJ_TOKEN = 'dj-token';
// A fake verifier: the DJ token maps to a dj; anything else is rejected.
const verifier: JwtVerifier = {
  verify: async (token: string): Promise<AuthUser> => {
    if (token === DJ_TOKEN) return { id: 'u1', name: 'DJ Moonbeam', role: 'dj' };
    throw new Error('unknown token');
  },
};

const DEACTIVATE_RESPONSE = {
  active: false as const,
  deactivatedBy: { source: 'virtual_switch' as const },
  deactivatedAt: '2026-07-07T00:00:00.000Z',
};

describe('virtual-switch router — POST /deactivate', () => {
  let server: Server;
  let url: string;

  const mount = async (orchestrator: Partial<Orchestrator>) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/auto-dj',
      virtualSwitchRouter({ orchestrator: orchestrator as Orchestrator, verifier }),
    );
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  };

  const deactivate = (token: string | null = DJ_TOKEN) =>
    fetch(`${url}/api/auto-dj/deactivate`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('returns 200 with the deactivate response on a clean teardown', async () => {
    const getDeactivateResponse = vi.fn(() => DEACTIVATE_RESPONSE);
    await mount({
      deactivate: vi.fn(async () => ({ state: {} as never, effects: [] })),
      getDeactivateResponse,
    });
    const res = await deactivate();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEACTIVATE_RESPONSE);
  });

  it('returns 409 when auto-DJ is not currently active (NOT_ACTIVE)', async () => {
    await mount({
      deactivate: vi.fn(async () => ({
        state: {} as never,
        effects: [],
        rejection: 'NOT_ACTIVE' as const,
      })),
    });
    const res = await deactivate();
    expect(res.status).toBe(409);
  });

  it('returns 502 when the BS flowsheet.end() teardown failed (#15)', async () => {
    // The real orchestrator resolves deactivate() with failedEffect: 'END_SHOW'
    // and converges to INACTIVE — proven in orchestrator.test.ts. The show is
    // still live on the flowsheet; a 200 here would tell dj-site the switch is
    // off while auto-DJ keeps playing (the mirror of the /activate 502).
    const getDeactivateResponse = vi.fn(() => DEACTIVATE_RESPONSE);
    await mount({
      deactivate: vi.fn(async () => ({
        state: {} as never,
        effects: [],
        failedEffect: 'END_SHOW' as const,
      })),
      getDeactivateResponse,
    });
    const res = await deactivate();
    expect(res.status).toBe(502);
    // The success body is never sent when the teardown didn't complete.
    expect(getDeactivateResponse).not.toHaveBeenCalled();
  });

  it('rejects a missing token with 401 and never touches the orchestrator', async () => {
    const deactivateFn = vi.fn(async () => ({ state: {} as never, effects: [] }));
    await mount({ deactivate: deactivateFn });
    const res = await deactivate(null);
    expect(res.status).toBe(401);
    expect(deactivateFn).not.toHaveBeenCalled();
  });
});
