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

/**
 * The two 200 shapes `POST /flowsheet/join` answers with, as one value.
 *
 * `startedNew` is the discriminator: a `Show` (`id`) means this account now
 * owns a fresh show, a `ShowDJ` (`show_id`, and no `id` — `show_djs` has no
 * such column) means it was added to an already-open one as a co-host. Both
 * attempts in `join()` have to tell those apart, so the distinction is a field
 * rather than a re-cast at each call site.
 */
const showFrom = (data: unknown): { showId: number; startedNew: boolean } | undefined => {
  const rec = data as { id?: unknown; show_id?: unknown } | null;
  if (typeof rec?.id === 'number') return { showId: rec.id, startedNew: true };
  if (typeof rec?.show_id === 'number') return { showId: rec.show_id, startedNew: false };
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
   *    needed. Rather than silently co-hosting it (today's byte-identical
   *    fallback above), take it over: re-POST with `intent: 'takeover'` and
   *    `expected_show_id` set to the 409's `details.show.id`. That retry
   *    either succeeds (closes that show, starts a fresh one owned by this
   *    account) or 409s again, and the retry is bounded to one attempt —
   *    re-driving the loop would close a show BS never named to us.
   *
   * WHAT THE TAKEOVER IS AND IS NOT GUARANTEED BY. The reducer only dispatches
   * the effect that calls this method after `activate()` sees `state.liveDj`
   * false (`activation-state-machine.ts`), and external triggers are
   * serialized through the same promise chain, so no relay signal interleaves
   * between that check and this call. But `liveDj` is set solely from
   * `RELAY_STATE` — the mixing-board AUX relay the Arduino reports — which is
   * an orchestrator-local reading of the hardware and says nothing about what
   * BS thinks. Two gaps follow, and both end a show a human owns where the
   * pre-takeover code merely co-hosted it:
   *  - a stuck or mis-wired relay, or a DJ who opened their show in dj-site
   *    before flipping the board, reads not-live while a human genuinely has
   *    an open show;
   *  - `expected_show_id` is a compare-and-set on the show's IDENTITY, not on
   *    its abandonment. A human joining that same show between the 409 and the
   *    retry leaves `details.show.id` unchanged, so BS still accepts.
   * Narrowing this needs an abandonment signal in the decision — the 409
   * carries `details.show.start_time` — but whether Auto-DJ takes over
   * unconditionally or only past an idle threshold is a product question the
   * epic deliberately left open (WXYC/auto-dj-orchestrator#36), so this
   * deliberately does not invent a threshold.
   *
   * This is the rest of #32 (WXYC/auto-dj-orchestrator#36); the contract is
   * WXYC/wxyc-shared#415 and its server side WXYC/Backend-Service#2233.
   */
  async join(): Promise<number> {
    const djId = await this.opts.tokenManager.getUserId();
    const body: JoinRequestBody = { dj_id: djId, show_name: this.opts.showName };
    const first = await this.request('POST', '/flowsheet/join', body, { allowStatuses: [409] });

    const started = showFrom(first.data);
    if (started) {
      if (started.startedNew) {
        this.opts.logger?.info({ showId: started.showId }, 'auto-dj show started');
      } else {
        this.opts.logger?.warn(
          { showId: started.showId },
          'auto-dj joined an already-open show as co-host; no new show started',
        );
      }
      return started.showId;
    }

    if (first.status !== 409 || !isShowAlreadyOpenBody(first.data)) {
      // Carry the status and body through: `allowStatuses` suppressed
      // `request()`'s own error, so this is the only place an unrecognized 409
      // (a future `code`, or a proxy's non-JSON error page) gets described.
      throw new Error(
        `BS POST /flowsheet/join -> ${first.status} returned no show id ${first.text.slice(0, 200)}`,
      );
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
    const takenOver = showFrom(retry.data);
    if (takenOver) {
      if (takenOver.startedNew) {
        this.opts.logger?.info(
          { showId: takenOver.showId, closedShowId: openShowId },
          'auto-dj took over an abandoned show',
        );
      } else {
        // ShowDJ-shaped: BS added this account to the open show rather than
        // closing it — the very outcome the takeover was meant to replace. Do
        // not report a close that did not happen.
        this.opts.logger?.warn(
          { showId: takenOver.showId, expectedShowId: openShowId },
          'auto-dj takeover returned a co-host membership; the open show was not closed',
        );
      }
      return takenOver.showId;
    }

    if (retry.status === 409) {
      // Bounded to one attempt: re-driving the loop would close a show BS
      // never named to us. Report both ids rather than asserting which case
      // this is — BS may reuse `show_already_open` to reject the takeover of
      // the very show we named, not only to report a different one.
      const collidedShowId = isShowAlreadyOpenBody(retry.data)
        ? retry.data.details?.show?.id
        : undefined;
      throw new Error(
        `BS /flowsheet/join takeover of show ${openShowId} was refused with show_already_open; BS now reports show ${collidedShowId ?? 'unknown'} open`,
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
   * instead of a thrown Error. Callers that allow a status take on describing
   * it, so the raw `text` comes back alongside the parsed `data`.
   *
   * `data` tolerates an empty or non-JSON body by falling back to `{}`:
   * addEntry/addBreakpoint/end ignore the response, so a body-less 200/204
   * must not throw a spurious failure.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts?: { allowStatuses?: readonly number[] },
  ): Promise<{ status: number; data: unknown; text: string }> {
    const token = await this.opts.tokenManager.getToken();
    let resp = await this.send(method, path, body, token);
    if (resp.status === 401) {
      const fresh = await this.opts.tokenManager.refresh();
      resp = await this.send(method, path, body, fresh);
    }
    const text = await resp.text().catch(() => '');
    if (!resp.ok && !opts?.allowStatuses?.includes(resp.status)) {
      throw new Error(`BS ${method} ${path} -> ${resp.status} ${text.slice(0, 200)}`);
    }
    let data: unknown = {};
    try {
      if (text) data = JSON.parse(text);
    } catch {
      data = {};
    }
    return { status: resp.status, data, text };
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
