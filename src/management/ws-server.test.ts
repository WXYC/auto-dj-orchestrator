/**
 * Unit coverage for the ManagementWsServer readyState guards (§3.6): a send to a
 * closing/closed socket must be a silent no-op (ws.send throws on a non-OPEN
 * socket), and the keepalive must ping only OPEN sockets while terminating ones
 * that missed a pong. Fake sockets are injected into the private set so the
 * guarded branch — the whole point of the hardening — is exercised deterministically.
 */
import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ManagementWsServer } from './ws-server.js';
import { CommandQueue } from './command-queue.js';
import { DeviceStatusStore } from './device-status.js';
import type { Orchestrator } from '../core/orchestrator.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

const makeServer = () =>
  new ManagementWsServer({
    authKey: 'k',
    orchestrator: {} as unknown as Orchestrator, // guards never touch the orchestrator
    deviceStore: new DeviceStatusStore(60_000),
    commandQueue: new CommandQueue(),
    pingIntervalMs: 100_000,
    logger: silentLogger,
  });

const fakeSocket = (readyState: number, isAlive = true) => ({
  readyState,
  OPEN: WebSocket.OPEN,
  isAlive,
  send: vi.fn(),
  ping: vi.fn(),
  terminate: vi.fn(),
});

// Reach the private set + methods so the non-OPEN branch is testable without
// racing a real socket through the CLOSING transition.
type Internals = {
  sockets: Set<unknown>;
  broadcast: (payload: string) => void;
  pingAll: () => void;
};

describe('ManagementWsServer — readyState guards', () => {
  it('broadcast writes only to OPEN sockets (a closing/closed send is a no-op, not a throw)', () => {
    const internals = makeServer() as unknown as Internals;
    const open = fakeSocket(WebSocket.OPEN);
    const closing = fakeSocket(WebSocket.CLOSING);
    const closed = fakeSocket(WebSocket.CLOSED);
    internals.sockets.add(open);
    internals.sockets.add(closing);
    internals.sockets.add(closed);

    internals.broadcast('cmd');

    expect(open.send).toHaveBeenCalledWith('cmd');
    expect(closing.send).not.toHaveBeenCalled(); // guarded: ws.send would throw on CLOSING
    expect(closed.send).not.toHaveBeenCalled(); // guarded: ws.send would throw on CLOSED
  });

  it('pingAll pings only OPEN sockets and terminates ones that missed a pong', () => {
    const internals = makeServer() as unknown as Internals;
    const openAlive = fakeSocket(WebSocket.OPEN, true);
    const closing = fakeSocket(WebSocket.CLOSING, true);
    const deadOpen = fakeSocket(WebSocket.OPEN, false); // answered no pong since last cycle
    internals.sockets.add(openAlive);
    internals.sockets.add(closing);
    internals.sockets.add(deadOpen);

    internals.pingAll();

    expect(openAlive.ping).toHaveBeenCalledTimes(1);
    expect(closing.ping).not.toHaveBeenCalled(); // not OPEN -> guarded
    expect(deadOpen.ping).not.toHaveBeenCalled(); // missed pong -> terminated, never pinged
    expect(deadOpen.terminate).toHaveBeenCalledTimes(1);
    expect(internals.sockets.has(deadOpen)).toBe(false); // pruned from the set
  });
});
