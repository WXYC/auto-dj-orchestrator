import { describe, it, expect } from 'vitest';
import { TokenManager, decodeJwtExpMs, type TokenManagerOptions } from './token-manager.js';

function makeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.sig`;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers: { get: (k: string) => string | null };
}

const res = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

/** Scripted fetch: counts sign-in calls and returns a session, then a JWT. */
function makeFetch(jwt: string, opts?: { signInStatusesBeforeOk?: number[] }) {
  const counts = { signIn: 0, exchange: 0 };
  const beforeOk = [...(opts?.signInStatusesBeforeOk ?? [])];
  const fetchFn = (async (url: string) => {
    if (url.endsWith('/sign-in/email')) {
      counts.signIn += 1;
      const early = beforeOk.shift();
      if (early !== undefined) return res(early, {}, { 'retry-after': '0' });
      return res(200, { token: 'session-abc', user: { id: 'usr_autodj' } });
    }
    counts.exchange += 1;
    return res(200, { token: jwt });
  }) as unknown as typeof fetch;
  return { fetchFn, counts };
}

const baseOpts = (extra: Partial<TokenManagerOptions>): TokenManagerOptions => ({
  authUrl: 'http://auth/auth',
  email: 'auto-dj@wxyc.org',
  password: 'pw',
  origin: 'http://localhost:8090',
  refreshSkewMs: 60_000,
  now: () => 1_000_000,
  ...extra,
});

describe('decodeJwtExpMs', () => {
  it('reads exp (seconds) into epoch ms', () => {
    expect(decodeJwtExpMs(makeJwt(1700))).toBe(1_700_000);
  });
  it('returns null for a malformed token', () => {
    expect(decodeJwtExpMs('not-a-jwt')).toBeNull();
  });
});

describe('TokenManager', () => {
  it('signs in, exchanges for a JWT, and exposes the user id as dj_id', async () => {
    const jwt = makeJwt(2000);
    const { fetchFn, counts } = makeFetch(jwt);
    const tm = new TokenManager(baseOpts({ fetchFn, now: () => 1_000_000 }));
    expect(await tm.getToken()).toBe(jwt);
    expect(await tm.getUserId()).toBe('usr_autodj');
    expect(counts).toEqual({ signIn: 1, exchange: 1 });
  });

  it('returns the cached token until within the refresh skew, then refreshes', async () => {
    const jwt = makeJwt(2000); // exp = 2_000_000 ms
    let clock = 1_000_000;
    const { fetchFn, counts } = makeFetch(jwt);
    const tm = new TokenManager(baseOpts({ fetchFn, now: () => clock }));
    await tm.getToken();
    clock = 1_500_000; // still > exp(2_000_000) - skew(60_000)
    await tm.getToken();
    expect(counts.signIn).toBe(1); // cached
    clock = 1_950_000; // within skew of exp -> refresh
    await tm.getToken();
    expect(counts.signIn).toBe(2);
  });

  it('coalesces concurrent refreshes into a single round-trip (single-flight)', async () => {
    const jwt = makeJwt(2000);
    const { fetchFn, counts } = makeFetch(jwt);
    const tm = new TokenManager(baseOpts({ fetchFn }));
    const [a, b, c] = await Promise.all([tm.getToken(), tm.getToken(), tm.getToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(counts.signIn).toBe(1);
  });

  it('a reactive refresh racing a proactive refresh shares the one promise', async () => {
    const jwt = makeJwt(2000);
    const { fetchFn, counts } = makeFetch(jwt);
    const tm = new TokenManager(baseOpts({ fetchFn }));
    const proactive = tm.getToken();
    const reactive = tm.refresh(); // e.g. a 401 fired mid-flight
    const [t1, t2] = await Promise.all([proactive, reactive]);
    expect(t1).toBe(t2);
    expect(counts.signIn).toBe(1);
  });

  it('retries sign-in once on 429', async () => {
    const jwt = makeJwt(2000);
    const { fetchFn, counts } = makeFetch(jwt, { signInStatusesBeforeOk: [429] });
    const tm = new TokenManager(baseOpts({ fetchFn }));
    expect(await tm.getToken()).toBe(jwt);
    expect(counts.signIn).toBe(2);
  });
});
