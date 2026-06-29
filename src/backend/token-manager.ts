/**
 * Auto-DJ service-account token manager.
 *
 * Non-interactive Better-Auth sign-in, replicating wxyc-canary's proven flow:
 *   1. POST {authUrl}/sign-in/email  {email,password} + Origin  -> { token: session, user.id }
 *   2. GET  {authUrl}/token          Authorization: Bearer session + Origin -> { token: JWT }
 *
 * The account's `user.id` is the `dj_id` the BS controller requires
 * (`dj_id === req.auth.id`; the spec's integer example is wrong — it's a string).
 * Tokens are short-lived (~5 min); we refresh proactively before `exp` and
 * reactively on a 401. Concurrent refreshes coalesce onto one in-flight promise.
 */
import type { Logger } from '../logger.js';

export interface TokenManagerOptions {
  authUrl: string;
  email: string;
  password: string;
  /** Sent as `Origin:`; must be in the auth service's BETTER_AUTH_TRUSTED_ORIGINS. */
  origin: string;
  refreshSkewMs: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

/** Decode a JWT's `exp` (seconds) into epoch ms, or null if absent/unparseable. */
export function decodeJwtExpMs(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

const DEFAULT_TTL_MS = 5 * 60_000;

export class TokenManager {
  private jwt: string | null = null;
  private expMs = 0;
  private userId: string | null = null;
  private refreshPromise: Promise<string> | null = null;

  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** A valid JWT, refreshing transparently when it is missing or near expiry. */
  async getToken(): Promise<string> {
    if (this.jwt && this.now() < this.expMs - this.opts.refreshSkewMs) return this.jwt;
    return this.refresh();
  }

  /** The Auto-DJ account's user id (the `dj_id` for join/end). Triggers a sign-in if unknown. */
  async getUserId(): Promise<string> {
    if (!this.userId) await this.refresh();
    if (!this.userId) throw new Error('token-manager: sign-in returned no user id');
    return this.userId;
  }

  /** Force a refresh (e.g. after a 401). Single-flight: concurrent callers share one promise. */
  refresh(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<string> {
    const { authUrl, email, password, origin } = this.opts;

    let signIn = await this.fetchFn(`${authUrl}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ email, password }),
    });
    if (signIn.status === 429) {
      const raw = signIn.headers.get('retry-after');
      const retryAfterMs = raw != null && Number.isFinite(Number(raw)) ? Number(raw) * 1000 : 2000;
      await delay(Math.min(Math.max(retryAfterMs, 0), 5000));
      signIn = await this.fetchFn(`${authUrl}/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email, password }),
      });
    }
    if (!signIn.ok) {
      throw new Error(`auth sign-in failed with ${signIn.status}`);
    }
    const signInBody = (await signIn.json()) as { token?: string; user?: { id?: string } };
    if (!signInBody?.token) throw new Error('auth sign-in returned no session token');
    this.userId = signInBody.user?.id ?? this.userId;

    const exchange = await this.fetchFn(`${authUrl}/token`, {
      headers: { Authorization: `Bearer ${signInBody.token}`, Origin: origin },
    });
    if (!exchange.ok) throw new Error(`auth token exchange failed with ${exchange.status}`);
    const tokenBody = (await exchange.json()) as { token?: string };
    if (!tokenBody?.token) throw new Error('auth token exchange returned no JWT');

    this.jwt = tokenBody.token;
    this.expMs = decodeJwtExpMs(this.jwt) ?? this.now() + DEFAULT_TTL_MS;
    this.opts.logger?.debug({ expMs: this.expMs }, 'auto-dj token refreshed');
    return this.jwt;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
