/**
 * HTTP app: the virtual-switch API + a healthcheck. Returns the Express app so
 * index.ts can wrap it in an http.Server (the management-channel WS upgrade,
 * PR B, attaches to that server).
 */
import express, { type Express, type RequestHandler } from 'express';
import type { Orchestrator } from '../core/orchestrator.js';
import type { JwtVerifier } from './jwks-verifier.js';
import { virtualSwitchRouter } from './routes/virtual-switch.js';
import { arduinoHttpRouter, type ArduinoHttpDeps } from './routes/arduino-http.js';

export interface ServerDeps {
  orchestrator: Orchestrator;
  verifier: JwtVerifier;
  corsAllowedOrigins: string[];
  /** Arduino HTTP fallback (management channel). */
  arduino: Omit<ArduinoHttpDeps, 'orchestrator'>;
}

/** Minimal CORS for the dj-site browser origin(s). */
function cors(allowed: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.header('origin');
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(cors(deps.corsAllowedOrigins));

  app.get('/healthcheck', (_req, res) => {
    const status = deps.orchestrator.getStatus();
    res.status(200).json({ status: 'ok', active: status.active, device: status.device ?? null });
  });

  app.use(
    '/api/auto-dj',
    virtualSwitchRouter({ orchestrator: deps.orchestrator, verifier: deps.verifier }),
  );

  // Arduino HTTP fallback (WiFi): heartbeat, command poll, ack.
  app.use('/api/auto-dj', arduinoHttpRouter({ ...deps.arduino, orchestrator: deps.orchestrator }));

  return app;
}
