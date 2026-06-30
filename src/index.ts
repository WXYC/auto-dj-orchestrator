/**
 * Composition root. Wires config -> clients -> orchestrator -> HTTP server,
 * runs restart recovery, and starts the hourly ticker. On SIGTERM it closes
 * cleanly but does NOT end the show: a redeploy shouldn't kill an in-progress
 * auto-DJ show — recovery re-attaches on the next boot.
 */
import { createServer } from 'node:http';
import { AzuraCastSubscriber } from './azuracast/subscriber.js';
import { FlowsheetClient } from './backend/flowsheet-client.js';
import { TokenManager } from './backend/token-manager.js';
import { Orchestrator } from './core/orchestrator.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createJwtVerifier, remoteJwks } from './http/jwks-verifier.js';
import { createApp } from './http/server.js';
import { StateStore } from './persistence/state-store.js';
import { noDeviceProvider, noopArduinoSink } from './ports.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  logger.info({ port: config.ORCHESTRATOR_PORT }, 'auto-dj-orchestrator starting');

  const tokenManager = new TokenManager({
    authUrl: config.AUTH_SERVICE_URL,
    email: config.AUTO_DJ_EMAIL,
    password: config.AUTO_DJ_PASSWORD,
    origin: config.AUTH_TRUSTED_ORIGIN,
    refreshSkewMs: config.TOKEN_REFRESH_SKEW_MS,
    logger,
  });

  const flowsheet = new FlowsheetClient({
    backendUrl: config.BACKEND_SERVICE_URL,
    showName: config.AUTO_DJ_SHOW_NAME,
    tokenManager,
    logger,
  });

  const stateStore = new StateStore(config.STATE_STORE_PATH, logger);

  // The subscriber's callbacks reference the orchestrator, which references the
  // subscriber — break the cycle with a forward declaration. Callbacks only
  // fire after start(), by which point `orchestrator` is assigned.
  let orchestrator!: Orchestrator;
  const azuracast = new AzuraCastSubscriber(
    {
      wsUrl: config.AZURACAST_WS_URL,
      httpUrl: config.AZURACAST_HTTP_URL,
      stationShortcode: config.AZURACAST_STATION_SHORTCODE,
      safetyPollMs: config.AZURACAST_SAFETY_POLL_MS,
      fallbackPollMs: config.AZURACAST_FALLBACK_POLL_MS,
      logger,
    },
    {
      onTrack: (track) => void orchestrator.onTrack(track),
      onLive: (isLive) => void orchestrator.onLive(isLive),
    },
  );

  orchestrator = new Orchestrator({
    flowsheet,
    azuracast,
    arduino: noopArduinoSink, // PR B replaces with the management channel
    device: noDeviceProvider, // PR B replaces with live device status
    stateStore,
    logger,
  });

  const verifier = createJwtVerifier({
    issuer: config.BETTER_AUTH_ISSUER,
    audience: config.BETTER_AUTH_AUDIENCE,
    keyInput: remoteJwks(config.BETTER_AUTH_JWKS_URL),
  });

  const app = createApp({ orchestrator, verifier, corsAllowedOrigins: config.corsAllowedOrigins });
  const server = createServer(app);

  // The subscriber runs continuously (not per-activation) so the orchestrator
  // always knows now-playing + is_live; activation only gates flowsheet writes.
  azuracast.start();
  await orchestrator.recover();
  orchestrator.start();

  server.listen(config.ORCHESTRATOR_PORT, () => {
    logger.info({ port: config.ORCHESTRATOR_PORT }, 'auto-dj-orchestrator listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down (show is left running for recovery)');
    orchestrator.stop();
    server.close(() => process.exit(0));
    // Hard cap so a stuck connection can't hang shutdown.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
