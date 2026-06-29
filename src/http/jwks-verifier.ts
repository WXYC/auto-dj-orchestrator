/**
 * dj-site JWT verification, mirroring Backend-Service's `requirePermissions`
 * (verify against JWKS, check issuer/audience, gate on role). Used by the
 * virtual-switch routes.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type Role = 'member' | 'dj' | 'musicDirector' | 'stationManager';

const RANK: Record<Role, number> = { member: 0, dj: 1, musicDirector: 2, stationManager: 3 };

/** True when `role` is at least `min` in the WXYC role hierarchy. */
export function hasRole(role: string | undefined, min: Role): boolean {
  if (!role || !(role in RANK)) return false;
  return RANK[role as Role] >= RANK[min];
}

export interface AuthUser {
  id: string;
  name?: string;
  role?: string;
}

export interface JwtVerifier {
  verify(token: string): Promise<AuthUser>;
}

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  /** A jose key resolver — `remoteJwks(url)` in prod, or `() => key` in tests. */
  keyInput: JWTVerifyGetKey;
}

/** Build a JWKS resolver from a URL (production path). */
export function remoteJwks(url: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(url));
}

export function createJwtVerifier(opts: JwtVerifierOptions): JwtVerifier {
  return {
    async verify(token: string): Promise<AuthUser> {
      const { payload } = await jwtVerify(token, opts.keyInput, {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      const id = (payload.sub ?? (payload as Record<string, unknown>).id) as string | undefined;
      if (!id) throw new Error('jwt has no subject');
      return {
        id,
        name: (payload as Record<string, unknown>).name as string | undefined,
        role: (payload as Record<string, unknown>).role as string | undefined,
      };
    },
  };
}
