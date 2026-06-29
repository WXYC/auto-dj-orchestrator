/**
 * dj-site JWT auth middleware. `minRole = null` allows any authenticated user
 * (read-only status, so greyscale works for every dj-site user); the
 * activate/deactivate routes pass `'dj'`.
 */
import type { RequestHandler } from 'express';
import { hasRole, type AuthUser, type JwtVerifier, type Role } from '../jwks-verifier.js';

export function requireAuth(verifier: JwtVerifier, minRole: Role | null): RequestHandler {
  return async (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1] : null;
    if (!token) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }
    let user: AuthUser;
    try {
      user = await verifier.verify(token);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    if (minRole && !hasRole(user.role, minRole)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    res.locals.auth = user;
    next();
  };
}
