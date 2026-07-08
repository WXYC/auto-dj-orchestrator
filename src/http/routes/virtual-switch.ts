/**
 * Virtual switch API (networking-spec §3.10): dj-site activates/deactivates
 * auto-DJ and polls status. Reducer rejections become the documented 4xx codes;
 * the reducer itself stays pure.
 */
import { Router } from 'express';
import type { Orchestrator } from '../../core/orchestrator.js';
import { reduceStatusBelowDj } from '../../core/selectors.js';
import { hasRole, type AuthUser, type JwtVerifier } from '../jwks-verifier.js';
import { requireAuth } from '../middleware/require-dj-jwt.js';

export function virtualSwitchRouter(deps: {
  orchestrator: Orchestrator;
  verifier: JwtVerifier;
}): Router {
  const router = Router();
  const { orchestrator, verifier } = deps;

  // Read-only, reachable by any authenticated user (drives dj-site greyscale for
  // everyone), but the payload detail is role-gated per networking-spec §3.10.4:
  // `dj` and above see the full status; below-`dj` members get the
  // identity-reduced projection (no activating/deactivating DJ identity, no
  // showId). Access is unchanged — a missing/invalid token is still 401, a
  // member is never 403'd.
  router.get('/status', requireAuth(verifier, null), (_req, res) => {
    const auth = res.locals.auth as AuthUser;
    const status = orchestrator.getStatus();
    res.status(200).json(hasRole(auth.role, 'dj') ? status : reduceStatusBelowDj(status));
  });

  router.post('/activate', requireAuth(verifier, 'dj'), async (_req, res) => {
    const auth = res.locals.auth as AuthUser;
    const result = await orchestrator.activate({ userId: auth.id, userName: auth.name });
    if (result.rejection === 'LIVE_DJ') {
      res
        .status(409)
        .json({ error: 'A live DJ show is in progress', status: orchestrator.getStatus() });
      return;
    }
    if (result.rejection === 'ALREADY_ACTIVE') {
      res
        .status(409)
        .json({ error: 'Auto-DJ is already active', status: orchestrator.getStatus() });
      return;
    }
    // The reducer accepted the request, but a downstream effect (the BS show-start,
    // or the activation-intent/ACTIVE persist) may have failed. Key off the reported
    // failedEffect, NOT getStatus().active: a failed START_SHOW leaves phase
    // ACTIVATING and a failed post-join persist rolls to DEACTIVATING, both of which
    // isActive() counts as on-air — so `active` is true for a failed activation and
    // cannot distinguish it. Symmetric with /deactivate's END_SHOW 502.
    const status = orchestrator.getStatus();
    if (result.failedEffect) {
      res.status(502).json({ error: 'Activation failed (backend unavailable)', status });
      return;
    }
    res.status(200).json(status);
  });

  router.post('/deactivate', requireAuth(verifier, 'dj'), async (_req, res) => {
    const result = await orchestrator.deactivate();
    if (result.rejection === 'NOT_ACTIVE') {
      res.status(409).json({ error: 'Auto-DJ is not currently active' });
      return;
    }
    // Symmetric with /activate: the reducer accepted the request, but the BS
    // flowsheet.end() teardown may have failed, leaving the show live on the
    // flowsheet. The machine still converges to INACTIVE (so getStatus().active
    // can't reveal this — see #15), so we key off the teardown outcome the
    // orchestrator reports. Answer 502 rather than a 200 that would tell dj-site
    // the switch is off while auto-DJ keeps playing. Deliberately omit `status`:
    // it reports active:false, which would contradict "may still be live."
    if (result.failedEffect === 'END_SHOW') {
      res.status(502).json({
        error: 'Deactivation failed (backend unavailable); the flowsheet show may still be live',
      });
      return;
    }
    res.status(200).json(orchestrator.getDeactivateResponse());
  });

  return router;
}
