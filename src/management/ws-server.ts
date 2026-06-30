/**
 * Arduino-facing WebSocket management channel (networking-spec §3.6).
 *
 * Attaches to the shared http.Server's `upgrade` event, authenticates the
 * `X-Auto-DJ-Key` header before the handshake, then routes inbound frames:
 *   heartbeat    -> device status + relay-derived RELAY_STATE
 *   button_toggle-> BUTTON_TOGGLED, replies with ack { result: { active } }
 *   ack          -> resolve the pending command
 *   error        -> log at the reported level
 * Outbound commands are pushed as the queue enqueues them. WS ping/pong keepalive
 * terminates a socket that misses a pong (§3.6.5).
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Orchestrator } from '../core/orchestrator.js';
import type { Logger } from '../logger.js';
import { keysMatch } from '../http/middleware/require-auto-dj-key.js';
import { parseInbound, serialize } from './codec.js';
import type { CommandQueue } from './command-queue.js';
import type { DeviceStatusStore } from './device-status.js';

const WS_PATH = '/api/auto-dj/ws';

export interface ManagementWsServerDeps {
  authKey: string;
  orchestrator: Orchestrator;
  deviceStore: DeviceStatusStore;
  commandQueue: CommandQueue;
  pingIntervalMs: number;
  logger: Logger;
}

type TrackedSocket = WebSocket & { isAlive?: boolean };

export class ManagementWsServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<TrackedSocket>();
  private pinger: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ManagementWsServerDeps) {
    deps.commandQueue.setListener((command) => this.broadcast(serialize(command)));
  }

  /** Wire into the http.Server and start keepalive. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.pinger = setInterval(() => this.pingAll(), this.deps.pingIntervalMs);
  }

  close(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    this.deps.commandQueue.setListener(null);
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      // This is the only 'upgrade' listener, so an unmatched path must be closed
      // here or the socket dangles (FD leak / pre-auth DoS).
      socket.destroy();
      return;
    }
    if (!keysMatch(req.headers['x-auto-dj-key'] as string | undefined, this.deps.authKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws as TrackedSocket));
  }

  private onConnection(ws: TrackedSocket): void {
    this.sockets.add(ws);
    ws.isAlive = true;
    this.deps.logger.info('arduino connected to management channel');
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data: Buffer) => void this.onMessage(ws, data.toString()));
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.deps.logger.warn('arduino disconnected from management channel');
    });
    ws.on('error', (err) => this.deps.logger.warn({ err }, 'management ws error'));
    // Flush any commands queued before the device connected.
    for (const command of this.deps.commandQueue.getPending()) ws.send(serialize(command));
  }

  private async onMessage(ws: TrackedSocket, raw: string): Promise<void> {
    const msg = parseInbound(raw);
    if (!msg) {
      this.deps.logger.debug({ raw: raw.slice(0, 200) }, 'dropped invalid management frame');
      return;
    }
    switch (msg.type) {
      case 'heartbeat': {
        this.deps.deviceStore.update(msg);
        if (msg.relay_auto_dj_active !== undefined) {
          await this.deps.orchestrator.relayState(!msg.relay_auto_dj_active);
        }
        break;
      }
      case 'button_toggle': {
        await this.deps.orchestrator.buttonToggled();
        const active = this.deps.orchestrator.getStatus().active;
        ws.send(
          serialize({ type: 'ack', id: `btn_${msg.timestamp}`, status: 'ok', result: { active } }),
        );
        break;
      }
      case 'ack':
        this.deps.commandQueue.ack(msg.id);
        break;
      case 'error':
        this.deps.logger[msg.level === 'warning' ? 'warn' : 'error'](
          { module: msg.module, code: msg.code, count: msg.count },
          `arduino error: ${msg.message}`,
        );
        break;
    }
  }

  private broadcast(payload: string): void {
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private pingAll(): void {
    for (const ws of this.sockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        this.sockets.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}
