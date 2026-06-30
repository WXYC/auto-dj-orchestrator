/**
 * AzuraCast now-playing source.
 *
 * Centrifugo WebSocket push (primary) with an HTTP safety-net poll while
 * connected and an HTTP fallback poll when the WS is down (networking-spec
 * §3.2 / §3.9). Emits sh_id-deduped track changes and is_live transitions.
 * Push is an optimization over an always-working poll baseline — a Centrifugo
 * misconfiguration degrades to polling, it does not fail.
 */
import { Centrifuge } from 'centrifuge';
import { WebSocket } from 'ws';
import type { NowPlaying } from '../core/state.js';
import type { Logger } from '../logger.js';
import { extractNowPlaying } from './parse.js';

export interface AzuraCastCallbacks {
  onTrack(track: NowPlaying): void;
  onLive(isLive: boolean): void;
}

export interface AzuraCastSubscriberOptions {
  wsUrl: string;
  httpUrl: string;
  stationShortcode: string;
  safetyPollMs: number;
  fallbackPollMs: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

export interface AzuraCastSource {
  start(): void;
  stop(): void;
  /** The latest track seen, or null if none yet. Used to post a show's opening entry. */
  current(): NowPlaying | null;
}

export class AzuraCastSubscriber implements AzuraCastSource {
  private readonly fetchFn: typeof fetch;
  private centrifuge: Centrifuge | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private lastShId = 0;
  private lastIsLive: boolean | null = null;
  private latest: NowPlaying | null = null;

  constructor(
    private readonly opts: AzuraCastSubscriberOptions,
    private readonly cb: AzuraCastCallbacks,
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  start(): void {
    // Idempotent: a second start() without an intervening stop() would orphan
    // the prior poll timer and open a duplicate Centrifuge connection.
    if (this.pollTimer || this.centrifuge) return;
    this.connectCentrifuge();
    this.schedulePoll();
  }

  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.centrifuge?.disconnect();
    this.centrifuge = null;
    this.connected = false;
    // Reset dedupe state so a later re-subscribe re-emits the current track /
    // live state (the instance is reused across activate/deactivate cycles).
    this.lastShId = 0;
    this.lastIsLive = null;
  }

  current(): NowPlaying | null {
    return this.latest;
  }

  /** Feed a raw AzuraCast/Centrifugo payload through dedupe and emit events. */
  ingest(payload: unknown): void {
    const np = extractNowPlaying(payload);
    if (!np) return;
    this.latest = np;
    // Emit the live signal FIRST: a live-DJ takeover arrives as one payload with
    // a new sh_id AND is_live=true. Surfacing live before the track lets the
    // orchestrator deactivate before it would post the live DJ's track as an
    // auto-DJ entry.
    if (this.lastIsLive === null || np.isLive !== this.lastIsLive) {
      this.lastIsLive = np.isLive;
      this.cb.onLive(np.isLive);
    }
    if (np.shId > 0 && np.shId !== this.lastShId) {
      this.lastShId = np.shId;
      this.cb.onTrack(np);
    }
  }

  private connectCentrifuge(): void {
    try {
      const centrifuge = new Centrifuge(this.opts.wsUrl, {
        websocket: WebSocket,
      });
      const sub = centrifuge.newSubscription(`station:${this.opts.stationShortcode}`, {
        recoverable: true,
      });
      sub.on('publication', (ctx) => this.ingest(ctx.data));
      centrifuge.on('connected', () => {
        this.connected = true;
        this.opts.logger?.info('azuracast centrifugo connected');
      });
      centrifuge.on('disconnected', () => {
        this.connected = false;
        this.opts.logger?.warn('azuracast centrifugo disconnected; falling back to polling');
      });
      centrifuge.on('error', (ctx) =>
        this.opts.logger?.warn({ err: ctx.error }, 'azuracast centrifugo error'),
      );
      sub.subscribe();
      centrifuge.connect();
      this.centrifuge = centrifuge;
    } catch (err) {
      this.opts.logger?.warn({ err }, 'azuracast centrifugo unavailable; polling only');
    }
  }

  /** Poll the static HTTP endpoint. Acts as a safety net when connected and the only source when not. */
  private schedulePoll(): void {
    const tick = async () => {
      // Re-arm at the right cadence for the current connection state.
      const interval = this.connected ? this.opts.safetyPollMs : this.opts.fallbackPollMs;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(tick, interval);
      try {
        const resp = await this.fetchFn(this.opts.httpUrl);
        if (resp.ok) this.ingest(await resp.json());
      } catch (err) {
        this.opts.logger?.debug({ err }, 'azuracast poll failed');
      }
    };
    // Kick off immediately so we have data at boot.
    this.pollTimer = setTimeout(tick, 0);
  }
}
