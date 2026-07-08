/**
 * Route-level coverage for the virtual-switch API (networking-spec §3.10): the
 * dj-site-facing activate/deactivate/status surface. Exercises the router
 * against a real express app with a fake Orchestrator and a fake JwtVerifier —
 * no Backend-Service and no JWKS endpoint (the arduino-http.test.ts /
 * ws-server.test.ts injection pattern). Covers every documented status code
 * across both auth scopes, plus the middleware's two 401 branches (a missing or
 * malformed Bearer header, and an invalid token whose verify() throws) and the
 * failed-downstream-effect 502 on both /activate and /deactivate.
 *
 * The /deactivate failed-teardown 502 keys off the outcome the orchestrator
 * reports (`deactivate().failedEffect === 'END_SHOW'`), NOT getStatus().active.
 * Since the recovery redesign a failed teardown stays DEACTIVATING (the show is
 * still live in BS until reconcile confirms off-air) — which `isActive` counts as
 * on-air, so `active` is `true` after a failed deactivate and `false` after a
 * clean one. The router still uses `failedEffect`, not `active`: it is the precise
 * per-request outcome, whereas `active` describes live air state that a later
 * reconcile can flip (it retries end() and eventually converges INACTIVE) while
 * this request's teardown still failed. See #15, and the recovery redesign #17.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { virtualSwitchRouter } from './virtual-switch.js';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { RejectionCode } from '../../core/activation-state-machine.js';
import type { AuthUser, JwtVerifier } from '../jwks-verifier.js';
import type { AutoDJDeactivateResponse, AutoDJStatus } from '@wxyc/shared/auto-dj';

// A stateless fake verifier: a known token maps to a user, anything else throws
// (the invalid-token path). A request with no/one-part Authorization header
// never reaches verify() — the middleware 401s first.
const USERS: Record<string, AuthUser> = {
  'dj-token': { id: 'u-dj', name: 'Nilüfer Yanya', role: 'dj' },
  'member-token': { id: 'u-mem', name: 'Angel Olsen', role: 'member' },
  // A role above 'dj', to prove the gate is hasRole(>=), not an exact-dj match.
  'md-token': { id: 'u-md', name: 'Jessica Pratt', role: 'musicDirector' },
  // An authenticated token with no `role` claim, to prove GET /status fails
  // closed (reduced payload) rather than defaulting a missing role to full (#21).
  'norole-token': { id: 'u-nr', name: 'Cate Le Bon' },
};
const verifier: JwtVerifier = {
  async verify(token) {
    const user = USERS[token];
    if (!user) throw new Error('unknown token');
    return user;
  },
};

// The slice of Orchestrator the router touches, typed to what the handlers
// actually read (`.rejection`, `.failedEffect`, `.active`, and the pass-through
// deactivate body) rather than the full reducer ReduceResult — the loose-fake
// injection style of arduino-http.test.ts. mount() casts back to Orchestrator
// at the boundary.
type FakeOrchestrator = {
  getStatus: () => AutoDJStatus;
  activate: (by: { userId?: string; userName?: string }) => Promise<{ rejection?: RejectionCode }>;
  deactivate: () => Promise<{ rejection?: RejectionCode; failedEffect?: 'END_SHOW' }>;
  getDeactivateResponse: () => AutoDJDeactivateResponse;
};

/** A minimal AutoDJStatus stub — `active` + a null device, no identity fields. */
const status = (active: boolean): AutoDJStatus => ({ active, device: null });

// Full status payloads carrying the identity/internal fields #21 gates:
// activatedBy / lastDeactivatedBy (Better Auth userId + userName) and showId.
const FULL_ACTIVE: AutoDJStatus = {
  active: true,
  activatedBy: { source: 'virtual_switch', userId: 'u-dj', userName: 'Nilüfer Yanya' },
  activatedAt: '2026-07-07T00:00:00.000Z',
  showId: 42,
  currentTrack: {
    artist: 'Juana Molina',
    title: 'la paradoja',
    album: 'DOGA',
    detectedAt: '2026-07-07T00:00:00.000Z',
  },
  device: null,
};
const FULL_INACTIVE: AutoDJStatus = {
  active: false,
  lastDeactivatedAt: '2026-07-07T01:00:00.000Z',
  lastDeactivatedBy: { source: 'virtual_switch', userId: 'u-dj', userName: 'Nilüfer Yanya' },
  device: null,
};

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** Mount the router on a fresh app + ephemeral server; returns the base URL. */
const mount = async (orchestrator: Partial<FakeOrchestrator>): Promise<string> => {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/auto-dj',
    virtualSwitchRouter({ orchestrator: orchestrator as unknown as Orchestrator, verifier }),
  );
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://localhost:${(server!.address() as AddressInfo).port}`;
};

// Send with a Bearer token (or none). `rawAuth`, when given, sets the
// Authorization header verbatim — for the malformed-header path (no Bearer
// prefix) that the token parser rejects before verify() runs.
const send = (url: string, method: string, path: string, token?: string, rawAuth?: string) => {
  const headers: Record<string, string> = {};
  if (rawAuth !== undefined) headers.Authorization = rawAuth;
  else if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}${path}`, { method, headers });
};

/** The 200-body a clean teardown returns (networking-spec §3.10). */
const DEACTIVATE_RESPONSE: AutoDJDeactivateResponse = {
  active: false,
  deactivatedBy: { source: 'virtual_switch' },
  deactivatedAt: '2026-07-07T00:00:00.000Z',
};

describe('virtual-switch router', () => {
  describe('GET /status', () => {
    it('returns 200 with the orchestrator status payload', async () => {
      const url = await mount({ getStatus: vi.fn(() => status(false)) });
      const res = await send(url, 'GET', '/api/auto-dj/status', 'dj-token');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(status(false));
    });

    it('requires a token even though it needs no dj scope (401 when missing)', async () => {
      const getStatus = vi.fn(() => status(false));
      const url = await mount({ getStatus });
      const res = await send(url, 'GET', '/api/auto-dj/status');
      expect(res.status).toBe(401);
      expect(getStatus).not.toHaveBeenCalled();
    });

    it('rejects an invalid token with 401 before reaching the orchestrator', async () => {
      // A present-but-unknown Bearer token: verifier.verify() throws -> 401.
      const getStatus = vi.fn(() => status(false));
      const url = await mount({ getStatus });
      const res = await send(url, 'GET', '/api/auto-dj/status', 'bogus-token');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid token' });
      expect(getStatus).not.toHaveBeenCalled();
    });

    it('rejects a malformed Authorization header (no Bearer prefix) with 401', async () => {
      const getStatus = vi.fn(() => status(false));
      const url = await mount({ getStatus });
      const res = await send(url, 'GET', '/api/auto-dj/status', undefined, 'dj-token');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Missing bearer token' });
      expect(getStatus).not.toHaveBeenCalled();
    });

    it('is allowed for any authenticated user — a member (non-dj) still gets 200', async () => {
      const url = await mount({ getStatus: vi.fn(() => status(true)) });
      const res = await send(url, 'GET', '/api/auto-dj/status', 'member-token');
      expect(res.status).toBe(200);
    });

    // #21: access is unchanged (all authenticated users still 200), but the
    // payload detail is role-gated — `dj` and above see the full status,
    // below-`dj` users get an identity-reduced projection (no activatedBy /
    // lastDeactivatedBy / showId) in both the active and inactive branches.
    describe('role-reduced payload (#21)', () => {
      it('serves a dj the full active payload (activatedBy + showId present)', async () => {
        const url = await mount({ getStatus: vi.fn(() => FULL_ACTIVE) });
        const res = await send(url, 'GET', '/api/auto-dj/status', 'dj-token');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(FULL_ACTIVE);
      });

      it('serves a dj the full inactive payload (lastDeactivatedBy present)', async () => {
        const url = await mount({ getStatus: vi.fn(() => FULL_INACTIVE) });
        const res = await send(url, 'GET', '/api/auto-dj/status', 'dj-token');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(FULL_INACTIVE);
      });

      it('serves an above-dj musicDirector the full payload (gate is hasRole(>=), not exact dj)', async () => {
        const url = await mount({ getStatus: vi.fn(() => FULL_ACTIVE) });
        const res = await send(url, 'GET', '/api/auto-dj/status', 'md-token');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(FULL_ACTIVE);
      });

      it('reduces the active payload for a member: drops activatedBy + showId, keeps the track', async () => {
        const url = await mount({ getStatus: vi.fn(() => FULL_ACTIVE) });
        const res = await send(url, 'GET', '/api/auto-dj/status', 'member-token');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          active: true,
          activatedAt: FULL_ACTIVE.activatedAt,
          currentTrack: FULL_ACTIVE.currentTrack,
          device: null,
        });
      });

      it('reduces the inactive payload for a member: drops lastDeactivatedBy', async () => {
        const url = await mount({ getStatus: vi.fn(() => FULL_INACTIVE) });
        const res = await send(url, 'GET', '/api/auto-dj/status', 'member-token');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          active: false,
          lastDeactivatedAt: FULL_INACTIVE.lastDeactivatedAt,
          device: null,
        });
      });

      it('reduces the payload for an authenticated token with no role claim (fail-closed)', async () => {
        const url = await mount({ getStatus: vi.fn(() => FULL_ACTIVE) });
        const res = await send(url, 'GET', '/api/auto-dj/status', 'norole-token');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).not.toHaveProperty('activatedBy');
        expect(body).not.toHaveProperty('showId');
      });
    });
  });

  describe('POST /activate', () => {
    it('activates for a dj and returns 200 with the resulting status', async () => {
      const activate = vi.fn(async () => ({}));
      const url = await mount({ activate, getStatus: vi.fn(() => status(true)) });
      const res = await send(url, 'POST', '/api/auto-dj/activate', 'dj-token');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(status(true));
      // The authenticated dj is threaded through to the reducer.
      expect(activate).toHaveBeenCalledWith({ userId: 'u-dj', userName: 'Nilüfer Yanya' });
    });

    it('allows a role above dj (musicDirector) — the gate is hasRole(>=), not exact dj', async () => {
      const activate = vi.fn(async () => ({}));
      const url = await mount({ activate, getStatus: vi.fn(() => status(true)) });
      const res = await send(url, 'POST', '/api/auto-dj/activate', 'md-token');
      expect(res.status).toBe(200);
      expect(activate).toHaveBeenCalledWith({ userId: 'u-md', userName: 'Jessica Pratt' });
    });

    it('rejects a missing token with 401 and never touches the orchestrator', async () => {
      const activate = vi.fn(async () => ({}));
      const url = await mount({ activate });
      const res = await send(url, 'POST', '/api/auto-dj/activate');
      expect(res.status).toBe(401);
      expect(activate).not.toHaveBeenCalled();
    });

    it('requires dj scope — a member is forbidden with 403', async () => {
      const activate = vi.fn(async () => ({}));
      const url = await mount({ activate });
      const res = await send(url, 'POST', '/api/auto-dj/activate', 'member-token');
      expect(res.status).toBe(403);
      expect(activate).not.toHaveBeenCalled();
    });

    it('returns 409 with the current status when a live DJ show is in progress (LIVE_DJ)', async () => {
      const url = await mount({
        activate: vi.fn(async () => ({ rejection: 'LIVE_DJ' as const })),
        getStatus: vi.fn(() => status(false)),
      });
      const res = await send(url, 'POST', '/api/auto-dj/activate', 'dj-token');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: 'A live DJ show is in progress',
        status: status(false),
      });
    });

    it('returns 409 with the current status when auto-DJ is already active (ALREADY_ACTIVE)', async () => {
      const url = await mount({
        activate: vi.fn(async () => ({ rejection: 'ALREADY_ACTIVE' as const })),
        getStatus: vi.fn(() => status(true)),
      });
      const res = await send(url, 'POST', '/api/auto-dj/activate', 'dj-token');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: 'Auto-DJ is already active',
        status: status(true),
      });
    });

    it('returns 502 when the reducer accepted but the downstream effect left it inactive', async () => {
      // activate() resolves with no rejection, yet the show-start effect failed
      // and rolled the state back — getStatus() still reports inactive.
      const url = await mount({
        activate: vi.fn(async () => ({})),
        getStatus: vi.fn(() => status(false)),
      });
      const res = await send(url, 'POST', '/api/auto-dj/activate', 'dj-token');
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error: 'Activation failed (backend unavailable)',
        status: status(false),
      });
    });
  });

  describe('POST /deactivate', () => {
    it('deactivates for a dj and returns 200 with the deactivate response', async () => {
      const url = await mount({
        deactivate: vi.fn(async () => ({})),
        getDeactivateResponse: vi.fn(() => DEACTIVATE_RESPONSE),
      });
      const res = await send(url, 'POST', '/api/auto-dj/deactivate', 'dj-token');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(DEACTIVATE_RESPONSE);
    });

    it('returns 502 when the BS flowsheet.end() teardown failed (#15)', async () => {
      // deactivate() resolves with failedEffect: 'END_SHOW' and converges to
      // INACTIVE (proven in orchestrator.test.ts): the show is still live on the
      // flowsheet, so a 200 would tell dj-site the switch is off while auto-DJ
      // keeps playing — the mirror of the /activate 502.
      const getDeactivateResponse = vi.fn(() => DEACTIVATE_RESPONSE);
      const url = await mount({
        deactivate: vi.fn(async () => ({ failedEffect: 'END_SHOW' as const })),
        getDeactivateResponse,
      });
      const res = await send(url, 'POST', '/api/auto-dj/deactivate', 'dj-token');
      expect(res.status).toBe(502);
      // The success body is never sent when the teardown didn't complete.
      expect(getDeactivateResponse).not.toHaveBeenCalled();
    });

    it('returns 409 when auto-DJ is not currently active (NOT_ACTIVE)', async () => {
      const url = await mount({
        deactivate: vi.fn(async () => ({ rejection: 'NOT_ACTIVE' as const })),
      });
      const res = await send(url, 'POST', '/api/auto-dj/deactivate', 'dj-token');
      expect(res.status).toBe(409);
    });

    it('rejects a missing token with 401 and never touches the orchestrator', async () => {
      const deactivate = vi.fn(async () => ({}));
      const url = await mount({ deactivate });
      const res = await send(url, 'POST', '/api/auto-dj/deactivate');
      expect(res.status).toBe(401);
      expect(deactivate).not.toHaveBeenCalled();
    });

    it('requires dj scope — a member is forbidden with 403', async () => {
      const deactivate = vi.fn(async () => ({}));
      const url = await mount({ deactivate });
      const res = await send(url, 'POST', '/api/auto-dj/deactivate', 'member-token');
      expect(res.status).toBe(403);
      expect(deactivate).not.toHaveBeenCalled();
    });
  });
});
