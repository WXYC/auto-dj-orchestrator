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

/** Wire values for `POST /flowsheet/join`'s `intent` field (wxyc-shared `FlowsheetJoinIntent`). */
type JoinIntent = 'join' | 'takeover';

interface JoinRequestBody {
  dj_id: string;
  show_name?: string;
  intent?: JoinIntent;
  expected_show_id?: number;
}

/**
 * The `POST /flowsheet/join` 409 body (wxyc-shared `ShowAlreadyOpenError`,
 * WXYC/wxyc-shared#415): a show the caller isn't a member of is open and
 * nothing said what to do about it. `details.show.id` is what a takeover
 * retry must echo back as `expected_show_id`.
 */
interface ShowAlreadyOpenBody {
  code?: string;
  details?: { show?: { id?: number } };
}

const isShowAlreadyOpenBody = (data: unknown): data is ShowAlreadyOpenBody =>
  typeof data === 'object' &&
  data !== null &&
  (data as { code?: unknown }).code === 'show_already_open';

const showIdFrom = (data: unknown): number | undefined => {
  const rec = data as { id?: unknown; show_id?: unknown } | null;
  if (typeof rec?.id === 'number') return rec.id;
  if (typeof rec?.show_id === 'number') return rec.show_id;
  return undefined;
};

export class FlowsheetClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: FlowsheetClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /**
   * Start a show as the Auto-DJ account; returns the show id.
   *
   * The first attempt sends no `intent`. That is the one state the wire
   * contract reserves for "the caller hasn't chosen" (wxyc-shared
   * `FlowsheetJoinIntent`) — which is exactly true here: Auto-DJ doesn't know
   * whether a collision even exists yet, so there's nothing to choose between
   * `join` and `takeover` until BS says so. This keeps the request
   * byte-identical to before this fix while `FLOWSHEET_TAKEOVER_ENABLED` is
   * off, or whenever no other show is open.
   *
   * BS answers that attempt one of three ways:
   *  - 200 `Show` (`id`): a new show started. Done.
   *  - 200 `ShowDJ` (`show_id`, no `id`): the flag is off, so a still-open
   *    show silently co-hosted this account. Not an error; logged at warn
   *    because it's a materially different outcome from owning a fresh show.
   *  - 409 `show_already_open`: the flag is on and a show this account isn't
   *    on is still open. `joinShow` routes on `getLatestShow()`, the newest
   *    show regardless of `end_time`, so Auto-DJ meets this whenever a DJ
   *    left without signing off — which is exactly when Auto-DJ is most
   *    needed. The reducer only dispatches the effect that calls this method
   *    after confirming `state.liveDj` is false (`activation-state-machine.ts`
   *    `activate()`), and external triggers are serialized through the same
   *    promise chain running this effect, so no live-DJ signal can interleave
   *    between that check and this call: the collision can only be an
   *    abandoned show, never a DJ genuinely on air right now. So rather than
   *    silently co-hosting it (today's byte-identical fallback above), take
   *    it over: re-POST with `intent: 'takeover'` and `expected_show_id` set
   *    to the 409's `details.show.id`. That retry either succeeds (closes the
   *    abandoned show, starts a fresh one owned by this account) or 409s
   *    again, meaning a DIFFERENT show opened in between — never shown to
   *    anyone, so the retry is bounded to one attempt rather than re-driving
   *    the loop against a show nobody chose.
   *
   * This is the rest of #32 (WXYC/auto-dj-orchestrator#36); the contract is
   * WXYC/wxyc-shared#415 and its server side WXYC/Backend-Service#2233.
   */
  async join(): Promise<number> {
    const djId = await this.opts.tokenManager.getUserId();
    const body: JoinRequestBody = { dj_id: djId, show_name: this.opts.showName };
    const first = await this.request('POST', '/flowsheet/join', body, { allowStatuses: [409] });

    const startedId = showIdFrom(first.data);
    if (startedId !== undefined) {
      if (typeof (first.data as { id?: unknown }).id === 'number') {
        this.opts.logger?.info({ showId: startedId }, 'auto-dj show started');
      } else {
        this.opts.logger?.warn(
          { showId: startedId },
          'auto-dj joined an already-open show as co-host; no new show started',
        );
      }
      return startedId;
    }

    if (first.status !== 409 || !isShowAlreadyOpenBody(first.data)) {
      throw new Error('BS /flowsheet/join returned no show id');
    }
    const openShowId = first.data.details?.show?.id;
    if (typeof openShowId !== 'number') {
      throw new Error('BS /flowsheet/join 409 carried no details.show.id to take over');
    }

    this.opts.logger?.warn(
      { showId: openShowId },
      'auto-dj found an open show with no live DJ; taking it over',
    );
    const retry = await this.request(
      'POST',
      '/flowsheet/join',
      { ...body, intent: 'takeover', expected_show_id: openShowId } satisfies JoinRequestBody,
      { allowStatuses: [409] },
    );
    const takenOverId = showIdFrom(retry.data);
    if (takenOverId !== undefined) {
      this.opts.logger?.info(
        { showId: takenOverId, closedShowId: openShowId },
        'auto-dj took over an abandoned show',
      );
      return takenOverId;
    }

    if (retry.status === 409) {
      // Bounded: a second 409 means a different show is open now than the one
      // BS just told us about. Re-driving the loop would close a show nobody
      // was ever shown.
      throw new Error(
        `BS /flowsheet/join takeover collided again; a different show is open (was expecting ${openShowId})`,
      );
    }
    throw new Error('BS /flowsheet/join takeover returned no show id');
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
    const { data } = await this.request(
      'GET',
      `/flowsheet/on-air?dj_id=${encodeURIComponent(djId)}`,
    );
    return Boolean((data as { is_live?: boolean }).is_live);
  }

  /**
   * One request with a single reactive-refresh retry on 401. Throws on any
   * other non-2xx status, unless `allowStatuses` names it — `join()` passes
   * `[409]` so a `show_already_open` collision reaches the caller as data
   * (status + parsed body) instead of a thrown Error.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts?: { allowStatuses?: readonly number[] },
  ): Promise<{ status: number; data: unknown }> {
    const token = await this.opts.tokenManager.getToken();
    let resp = await this.send(method, path, body, token);
    if (resp.status === 401) {
      const fresh = await this.opts.tokenManager.refresh();
      resp = await this.send(method, path, body, fresh);
    }
    if (!resp.ok && !opts?.allowStatuses?.includes(resp.status)) {
      const text = await resp.text().catch(() => '');
      throw new Error(`BS ${method} ${path} -> ${resp.status} ${text.slice(0, 200)}`);
    }
    // Tolerate an empty / non-JSON body — addEntry/addBreakpoint/end ignore
    // the response, so a body-less 200/204 must not throw a spurious failure.
    const text = await resp.text();
    if (!text) return { status: resp.status, data: {} };
    try {
      return { status: resp.status, data: JSON.parse(text) };
    } catch {
      return { status: resp.status, data: {} };
    }
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
