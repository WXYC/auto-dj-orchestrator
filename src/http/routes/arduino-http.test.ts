/**
 * HTTP fallback (WiFi) for the management channel. Exercises auth, the heartbeat
 * relay/button handling, command poll, and ack against a real express app.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { arduinoHttpRouter } from './arduino-http.js';
import { CommandQueue } from '../../management/command-queue.js';
import { DeviceStatusStore } from '../../management/device-status.js';
import type { Orchestrator } from '../../core/orchestrator.js';

const KEY = 'test-key';
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

const heartbeat = (over: Record<string, unknown> = {}) => ({
  type: 'heartbeat',
  state: 'CONNECTED',
  transport: 'wifi',
  uptime_s: 1,
  free_ram: 1,
  firmware_version: '2.0.0',
  config_hash: 'a',
  loop_max_ms: 1,
  reconnect_count: 0,
  tracks_detected: 0,
  tracks_posted: 0,
  errors_since_boot: 0,
  ...over,
});

describe('arduino HTTP fallback router', () => {
  let server: Server;
  let url: string;
  let orchestrator: {
    relayState: ReturnType<typeof vi.fn>;
    buttonToggled: ReturnType<typeof vi.fn>;
  };
  let commandQueue: CommandQueue;
  let deviceStore: DeviceStatusStore;

  beforeEach(async () => {
    orchestrator = { relayState: vi.fn(async () => {}), buttonToggled: vi.fn(async () => {}) };
    commandQueue = new CommandQueue();
    deviceStore = new DeviceStatusStore(60_000);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/auto-dj',
      arduinoHttpRouter({
        authKey: KEY,
        orchestrator: orchestrator as unknown as Orchestrator,
        deviceStore,
        commandQueue,
        logger: silentLogger,
      }),
    );
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (path: string, body: unknown, key: string | null = KEY) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Auto-DJ-Key': key } : {}) },
      body: JSON.stringify(body),
    });

  it('rejects requests without the key (401)', async () => {
    expect((await post('/api/auto-dj/heartbeat', heartbeat(), null)).status).toBe(401);
  });

  it('a heartbeat updates device status and feeds relay state', async () => {
    const res = await post('/api/auto-dj/heartbeat', heartbeat({ relay_auto_dj_active: false }));
    expect(res.status).toBe(200);
    expect(orchestrator.relayState).toHaveBeenCalledWith(true); // relay false => live DJ
    expect(deviceStore.summary()).toMatchObject({
      online: true,
      transport: 'wifi',
      relayState: 'dj_live',
    });
  });

  it('toggles once on an odd button_press_count and not at all on an even count', async () => {
    await post('/api/auto-dj/heartbeat', heartbeat({ button_press_count: 1 }));
    expect(orchestrator.buttonToggled).toHaveBeenCalledTimes(1);
    await post('/api/auto-dj/heartbeat', heartbeat({ button_press_count: 2 }));
    expect(orchestrator.buttonToggled).toHaveBeenCalledTimes(1); // even cancels out
    await post('/api/auto-dj/heartbeat', heartbeat({ button_press_count: 0 }));
    expect(orchestrator.buttonToggled).toHaveBeenCalledTimes(1); // steady state never toggles
  });

  it('GET /commands returns pending commands and ack removes them', async () => {
    commandQueue.send('pause');
    const list = await fetch(`${url}/api/auto-dj/commands`, { headers: { 'X-Auto-DJ-Key': KEY } });
    expect(await list.json()).toEqual([{ type: 'command', id: 'cmd_1', action: 'pause' }]);

    await post('/api/auto-dj/commands/ack', { id: 'cmd_1' });
    expect(commandQueue.pendingCount).toBe(0);
  });

  it('rejects a malformed heartbeat body (400)', async () => {
    expect((await post('/api/auto-dj/heartbeat', { type: 'heartbeat' })).status).toBe(400);
  });

  it('handles an ack POST with no body without throwing a 500', async () => {
    const res = await fetch(`${url}/api/auto-dj/commands/ack`, {
      method: 'POST',
      headers: { 'X-Auto-DJ-Key': KEY }, // no Content-Type / body
    });
    expect(res.status).toBe(200);
  });
});
