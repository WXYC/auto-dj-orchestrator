/**
 * Backend-Service flowsheet client. The orchestrator is the sole writer; BS
 * mirrors every write to tubafrenzy automatically, so there is no direct
 * tubafrenzy path here. Authenticates as the Auto-DJ service account via the
 * TokenManager and creates the show AS that account (`dj_id === user.id`).
 */
import type { NowPlaying } from '../core/state.js';
import type { Logger } from '../logger.js';
import { breakpointBody, mapTrackToEntry } from './map-track.js';
import type { TokenManager } from './token-manager.js';

export interface FlowsheetClientOptions {
  backendUrl: string;
  showName: string;
  tokenManager: TokenManager;
  fetchFn?: typeof fetch;
  logger?: Logger;
  /** AbortController timeout for BS calls. */
  timeoutMs?: number;
}

export class FlowsheetClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: FlowsheetClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Start a show as the Auto-DJ account; returns the new show id. */
  async join(): Promise<number> {
    const djId = await this.opts.tokenManager.getUserId();
    const data = (await this.request('POST', '/flowsheet/join', {
      dj_id: djId,
      show_name: this.opts.showName,
    })) as { id: number };
    this.opts.logger?.info({ showId: data.id }, 'auto-dj show started');
    return data.id;
  }

  async addEntry(track: NowPlaying): Promise<void> {
    await this.request('POST', '/flowsheet', mapTrackToEntry(track));
  }

  /** Top-of-hour breakpoint marker (BS does not auto-insert these). */
  async addBreakpoint(): Promise<void> {
    await this.request('POST', '/flowsheet', breakpointBody());
  }

  async end(): Promise<void> {
    const djId = await this.opts.tokenManager.getUserId();
    await this.request('POST', '/flowsheet/end', { dj_id: djId });
    this.opts.logger?.info('auto-dj show ended');
  }

  /** Restart-recovery probe: is the Auto-DJ account currently on air per BS? */
  async isOnAir(): Promise<boolean> {
    const djId = await this.opts.tokenManager.getUserId();
    const data = (await this.request(
      'GET',
      `/flowsheet/on-air?dj_id=${encodeURIComponent(djId)}`,
    )) as { is_live?: boolean };
    return Boolean(data.is_live);
  }

  /** One request with a single reactive-refresh retry on 401. */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const token = await this.opts.tokenManager.getToken();
    let resp = await this.send(method, path, body, token);
    if (resp.status === 401) {
      const fresh = await this.opts.tokenManager.refresh();
      resp = await this.send(method, path, body, fresh);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`BS ${method} ${path} -> ${resp.status} ${text.slice(0, 200)}`);
    }
    return resp.json();
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    token: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      return await this.fetchFn(`${this.opts.backendUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
