/**
 * HTTP fallback for the management channel (networking-spec §3.7), used when the
 * Arduino is on WiFi and can't hold a WebSocket. Same heartbeat body as the WS
 * frame; button presses are carried as `button_press_count` and toggle when odd.
 */
import { Router } from 'express';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { Logger } from '../../logger.js';
import { validateInbound } from '../../management/codec.js';
import type { CommandQueue } from '../../management/command-queue.js';
import type { DeviceStatusStore } from '../../management/device-status.js';
import { requireAutoDjKey } from '../middleware/require-auto-dj-key.js';

export interface ArduinoHttpDeps {
  authKey: string;
  orchestrator: Orchestrator;
  deviceStore: DeviceStatusStore;
  commandQueue: CommandQueue;
  logger: Logger;
}

export function arduinoHttpRouter(deps: ArduinoHttpDeps): Router {
  const router = Router();
  router.use(requireAutoDjKey(deps.authKey));

  router.post('/heartbeat', async (req, res) => {
    const msg = validateInbound(req.body);
    if (!msg || msg.type !== 'heartbeat') {
      res.status(400).json({ error: 'Invalid heartbeat' });
      return;
    }
    deps.deviceStore.update(msg);
    if (msg.relay_auto_dj_active !== undefined) {
      await deps.orchestrator.relayState(!msg.relay_auto_dj_active);
    }
    // `button_press_count` is a per-heartbeat DELTA, not cumulative: the firmware
    // counts debounced presses since the last heartbeat and resets to 0 after a
    // successful POST (networking-spec §3.7 + plan-button §3). Toggling on odd
    // means an even number of presses between heartbeats cancels out, and a
    // steady state (0 presses) never toggles. Unlike reconnect_count /
    // tracks_detected / errors_since_boot, this field does NOT accumulate.
    if (msg.button_press_count && msg.button_press_count % 2 === 1) {
      await deps.orchestrator.buttonToggled();
    }
    res.sendStatus(200);
  });

  router.get('/commands', (_req, res) => {
    res.status(200).json(deps.commandQueue.getPending());
  });

  router.post('/commands/ack', (req, res) => {
    // req.body is undefined for an empty / non-JSON body — guard before reading.
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string') deps.commandQueue.ack(id);
    res.sendStatus(200);
  });

  return router;
}
