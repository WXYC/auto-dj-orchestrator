/**
 * X-Auto-DJ-Key auth for the Arduino-facing endpoints (networking-spec §4.4).
 * Timing-safe comparison; shared by the WS upgrade handshake and the HTTP
 * fallback routes.
 */
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function keysMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; guard so the comparison stays constant-time per length class.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireAutoDjKey(expected: string): RequestHandler {
  return (req, res, next) => {
    if (!keysMatch(req.header('x-auto-dj-key') ?? undefined, expected)) {
      res.status(401).json({ error: 'Invalid X-Auto-DJ-Key' });
      return;
    }
    next();
  };
}
