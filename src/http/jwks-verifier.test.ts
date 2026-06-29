import { describe, it, expect } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { createJwtVerifier, hasRole } from './jwks-verifier.js';

const ISSUER = 'http://localhost:8082';
const AUDIENCE = 'http://localhost:8082';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const verifier = createJwtVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keyInput: () => publicKey,
  });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject((claims.sub as string) ?? 'usr_1')
      .setExpirationTime('5m')
      .sign(privateKey);
  return { verifier, sign };
}

describe('hasRole', () => {
  it('respects the WXYC role hierarchy', () => {
    expect(hasRole('dj', 'dj')).toBe(true);
    expect(hasRole('musicDirector', 'dj')).toBe(true);
    expect(hasRole('stationManager', 'dj')).toBe(true);
    expect(hasRole('member', 'dj')).toBe(false);
    expect(hasRole(undefined, 'member')).toBe(false);
    expect(hasRole('bogus', 'member')).toBe(false);
  });
});

describe('createJwtVerifier', () => {
  it('verifies a valid token and extracts id/name/role', async () => {
    const { verifier, sign } = await setup();
    const token = await sign({ sub: 'usr_42', name: 'DJ Moonbeam', role: 'dj' });
    expect(await verifier.verify(token)).toEqual({ id: 'usr_42', name: 'DJ Moonbeam', role: 'dj' });
  });

  it('rejects a token signed for the wrong audience', async () => {
    const { sign } = await setup();
    const { publicKey } = await generateKeyPair('RS256');
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: 'someone-else',
      keyInput: () => publicKey,
    });
    const token = await sign({ sub: 'usr_1', role: 'dj' });
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});
