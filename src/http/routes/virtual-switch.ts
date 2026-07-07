/**
 * Virtual switch API (networking-spec §3.10): dj-site activates/deactivates
 * auto-DJ and polls status. Reducer rejections become the documented 4xx codes;
 * the reducer itself stays pure.
 */
import { Router } from 'express';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { AuthUser, JwtVerifier } from '../jwks-verifier.js';
import { requireAuth } from '../middleware/require-dj-jwt.js';

export function virtualSwitchRouter(deps: {
  orchestrator: Orchestrator;
  verifier: JwtVerifier;
}): Router {
  const router = Router();
  const { orchestrator, verifier } = deps;

  // Read-only: any authenticated user (drives dj-site greyscale for everyone).
  router.get('/status', requireAuth(verifier, null), (_req, res) => {
    res.status(200).json(orchestrator.getStatus());
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
    // The reducer accepted the request, but a downstream effect (e.g. the BS
    // show-start) may have failed and rolled the state back. Surface that as a
    // 502 rather than a misleading 200.
    const status = orchestrator.getStatus();
    if (!status.active) {
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
