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
import { CommandQueue } from './management/command-queue.js';
import { DeviceStatusStore } from './management/device-status.js';
import { ManagementWsServer } from './management/ws-server.js';

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
  const commandQueue = new CommandQueue();
  const deviceStore = new DeviceStatusStore(config.DEVICE_OFFLINE_THRESHOLD_MS);

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
      onTrack: (track) =>
        void orchestrator.onTrack(track).catch((err) => logger.error({ err }, 'onTrack failed')),
      onLive: (isLive) =>
        void orchestrator.onLive(isLive).catch((err) => logger.error({ err }, 'onLive failed')),
    },
  );

  orchestrator = new Orchestrator({
    flowsheet,
    azuracast,
    arduino: commandQueue,
    device: deviceStore,
    stateStore,
    logger,
  });

  const verifier = createJwtVerifier({
    issuer: config.BETTER_AUTH_ISSUER,
    audience: config.BETTER_AUTH_AUDIENCE,
    keyInput: remoteJwks(config.BETTER_AUTH_JWKS_URL),
  });

  const app = createApp({
    orchestrator,
    verifier,
    corsAllowedOrigins: config.corsAllowedOrigins,
    arduino: { authKey: config.AUTO_DJ_KEY, deviceStore, commandQueue, logger },
  });
  const server = createServer(app);

  const wsServer = new ManagementWsServer({
    authKey: config.AUTO_DJ_KEY,
    orchestrator,
    deviceStore,
    commandQueue,
    pingIntervalMs: config.WS_PING_INTERVAL_MS,
    logger,
  });
  wsServer.attach(server);

  // Recover from a persisted snapshot first (based on Backend-Service state),
  // THEN start the continuous subscriber. If recovery re-attached a show but a
  // live DJ is actually on air, the subscriber's first poll emits is_live before
  // any track (ingest order), so RELAY_STATE force-deactivates before any live
  // track is posted — self-correcting "live DJ wins".
  await orchestrator.recover();
  azuracast.start();
  orchestrator.start();

  server.listen(config.ORCHESTRATOR_PORT, () => {
    logger.info({ port: config.ORCHESTRATOR_PORT }, 'auto-dj-orchestrator listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // a second signal (SIGTERM then SIGINT) is a no-op
    shuttingDown = true;
    logger.info({ signal }, 'shutting down (show is left running for recovery)');
    orchestrator.stop();
    wsServer.close();
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
