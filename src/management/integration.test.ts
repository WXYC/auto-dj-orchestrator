/**
 * End-to-end management-channel integration: a real ws "Arduino" client drives
 * a real ManagementWsServer + Orchestrator, whose flowsheet writes land on a
 * mocked Backend-Service. Asserts the button -> join -> ack(result.active) and
 * relay(live DJ) -> end paths. (The HTTP fallback is covered in
 * src/http/routes/arduino-http.test.ts.)
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { Orchestrator } from '../core/orchestrator.js';
import { FlowsheetClient } from '../backend/flowsheet-client.js';
import { TokenManager } from '../backend/token-manager.js';
import { StateStore } from '../persistence/state-store.js';
import { CommandQueue } from './command-queue.js';
import { DeviceStatusStore } from './device-status.js';
import { ManagementWsServer } from './ws-server.js';
import type { AzuraCastSource } from '../azuracast/subscriber.js';

const AUTH_KEY = 'test-auto-dj-key';
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

interface BsCalls {
  join: unknown[];
  entries: unknown[];
  end: unknown[];
}

/** A mocked Backend-Service + auth service on one express app. */
function startBackendMock(): Promise<{ server: Server; url: string; calls: BsCalls }> {
  const calls: BsCalls = { join: [], entries: [], end: [] };
  const app = express();
  app.use(express.json());
  app.post('/auth/sign-in/email', (_req, res) =>
    res.json({ token: 'sess', user: { id: 'usr_autodj' } }),
  );
  app.get('/auth/token', (_req, res) => res.json({ token: 'jwt.aaa.bbb' }));
  app.get('/flowsheet/on-air', (_req, res) => res.json({ is_live: false }));
  app.post('/flowsheet/join', (req, res) => {
    calls.join.push(req.body);
    res.json({ id: 701 });
  });
  app.post('/flowsheet', (req, res) => {
    calls.entries.push(req.body);
    res.json({ id: 1 });
  });
  app.post('/flowsheet/end', (req, res) => {
    calls.end.push(req.body);
    res.json({ id: 701 });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://localhost:${port}`, calls });
    });
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Resolve with the first received message matching `match` (others, e.g. a resume command, are skipped). */
function waitForMessage(
  ws: WebSocket,
  match: (m: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMsg = (d: Buffer) => {
      const m = JSON.parse(d.toString());
      if (match(m)) {
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMs);
  });
}

describe('management channel integration', () => {
  let bs: Awaited<ReturnType<typeof startBackendMock>>;
  let server: Server;
  let wsServer: ManagementWsServer;
  let orchestrator: Orchestrator;
  let port: number;

  beforeEach(async () => {
    bs = await startBackendMock();
    const tokenManager = new TokenManager({
      authUrl: `${bs.url}/auth`,
      email: 'auto-dj@wxyc.org',
      password: 'pw',
      origin: 'http://localhost:8090',
      refreshSkewMs: 60_000,
    });
    const flowsheet = new FlowsheetClient({
      backendUrl: bs.url,
      showName: 'Auto DJ',
      tokenManager,
    });
    const fakeAzura: AzuraCastSource = { start() {}, stop() {}, current: () => null };
    const commandQueue = new CommandQueue();
    const deviceStore = new DeviceStatusStore(60_000);
    orchestrator = new Orchestrator({
      flowsheet,
      azuracast: fakeAzura,
      arduino: commandQueue,
      device: deviceStore,
      stateStore: new StateStore('/tmp/auto-dj-test-state.json'),
      logger: silentLogger,
    });
    server = createServer();
    wsServer = new ManagementWsServer({
      authKey: AUTH_KEY,
      orchestrator,
      deviceStore,
      commandQueue,
      pingIntervalMs: 100_000,
      logger: silentLogger,
    });
    wsServer.attach(server);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    wsServer.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bs.server.close(() => r()));
  });

  function connectArduino(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}/api/auto-dj/ws`, {
      headers: { 'x-auto-dj-key': AUTH_KEY },
    });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  it('rejects a WS upgrade without the key', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/auto-dj/ws`);
    await expect(new Promise((_r, reject) => ws.once('error', reject))).rejects.toBeTruthy();
  });

  it('button_toggle activates, creates the show as the Auto-DJ account, and acks with result.active', async () => {
    const ws = await connectArduino();
    ws.send(JSON.stringify({ type: 'button_toggle', timestamp: 1709852100 }));
    const ack = await waitForMessage(ws, (m) => m.type === 'ack');
    expect(ack).toMatchObject({
      type: 'ack',
      id: 'btn_1709852100',
      status: 'ok',
      result: { active: true },
    });
    await waitFor(() => bs.calls.join.length === 1);
    expect(bs.calls.join[0]).toEqual({ dj_id: 'usr_autodj', show_name: 'Auto DJ' });
    ws.close();
  });

  it('a heartbeat reporting a live DJ deactivates and ends the show', async () => {
    const ws = await connectArduino();
    ws.send(JSON.stringify({ type: 'button_toggle', timestamp: 1 }));
    await waitFor(() => bs.calls.join.length === 1);

    // relay_auto_dj_active: false => live DJ on air
    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        state: 'CONNECTED',
        transport: 'ethernet',
        uptime_s: 1,
        free_ram: 1,
        firmware_version: '2.0.0',
        config_hash: 'a',
        loop_max_ms: 1,
        reconnect_count: 0,
        tracks_detected: 0,
        tracks_posted: 0,
        errors_since_boot: 0,
        relay_auto_dj_active: false,
      }),
    );
    await waitFor(() => bs.calls.end.length === 1);
    expect(orchestrator.getStatus().active).toBe(false);
    ws.close();
  });
});
