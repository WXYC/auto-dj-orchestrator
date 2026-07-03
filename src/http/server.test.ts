/**
 * App composition: CORS must run before body parsing so an error thrown by
 * express.json() (a malformed-JSON 400) still carries Access-Control-Allow-Origin.
 * Otherwise the browser surfaces an opaque CORS error masking the real status.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp } from './server.js';
import { CommandQueue } from '../management/command-queue.js';
import { DeviceStatusStore } from '../management/device-status.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { JwtVerifier } from './jwks-verifier.js';

const ORIGIN = 'https://dj.wxyc.org';
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

describe('createApp CORS/body-parse ordering', () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    const orchestrator = {
      getStatus: () => ({ active: false, device: null }),
    } as unknown as Orchestrator;
    const app = createApp({
      orchestrator,
      verifier: (() => {}) as unknown as JwtVerifier,
      corsAllowedOrigins: [ORIGIN],
      arduino: {
        authKey: 'test-key',
        deviceStore: new DeviceStatusStore(60_000),
        commandQueue: new CommandQueue(),
        logger: silentLogger,
      },
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('keeps Access-Control-Allow-Origin on a malformed-JSON 400', async () => {
    const res = await fetch(`${url}/api/auto-dj/activate`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{ not valid json', // trips express.json() -> 400 before routing
    });
    expect(res.status).toBe(400);
    // The header proves cors ran before the body parser threw.
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('answers a CORS preflight (OPTIONS) with 204 and the allow-origin header', async () => {
    const res = await fetch(`${url}/api/auto-dj/activate`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});
