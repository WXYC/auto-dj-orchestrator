# auto-dj-orchestrator

Node/TypeScript service that bridges WXYC's auto-DJ (AzuraCast) with the station flowsheet. It is the **single brain** of the auto-DJ system: it owns activation state, conflict resolution, the AzuraCast subscription, all flowsheet writes, hourly breakpoints, the dj-site virtual switch API, and the Arduino management channel.

## Architecture

The orchestrator writes **only to Backend-Service**. BS mirrors every flowsheet write to legacy tubafrenzy automatically, so there is no direct-tubafrenzy path and no dual-backend flag. It authenticates as the **Auto-DJ service account** (a `dj`-role Better-Auth user) and creates the show AS that account (BS enforces `dj_id === req.auth.id`).

The Arduino is a "dumb" relay/button reporter; it does not talk to AzuraCast or write flowsheets. The orchestrator subscribes to AzuraCast and makes every decision.

```
dj-site ──(virtual switch, Better-Auth JWT)──▶ orchestrator ──(dj-role JWT)──▶ Backend-Service ──mirror──▶ tubafrenzy
                                                    │
Arduino ──(WS mgmt channel + HTTP fallback)─────────┤──(Centrifugo WS + HTTP poll)──▶ AzuraCast now-playing
```

## Core design: pure reducer + impure coordinator

`src/core/activation-state-machine.ts` is a **pure reducer** — `reduce(state, event) -> { state, effects[], rejection? }`. No I/O, no `Date.now()`: every event carries the `at`/`epochHour` it needs, so it is exhaustively unit-testable (deliberately mirroring the Arduino firmware's pure-`tick()` discipline). `src/core/orchestrator.ts` is the impure coordinator: it owns the state, serializes external triggers through a promise chain, and executes effects (`START_SHOW` -> `flowsheet.join()`, etc.) against the real clients.

Conflict rules (networking-spec §2.7): live DJ always wins; button ≡ virtual switch (last wins); no auto-reactivation after a live DJ clears.

## Flowsheet posting guarantee (at-least-once)

Entry posting is deliberately **at-least-once, never at-most-once**: `ENTRY_POSTED` persists the advanced dedupe key (`lastPostedShId`) only _after_ `flowsheet.addEntry()` succeeds (`src/core/orchestrator.ts` `POST_ENTRY` → `src/core/activation-state-machine.ts` `ENTRY_POSTED`). A failed post is retried rather than durably recorded as sent, so no entry is ever dropped; the price is that an ill-timed crash — BS accepts the entry, the process dies before the persist — re-posts one track on restart. At most one duplicate, never a drop. **Invariant: do not "tighten" these best-effort dedupe-key persists to `saveStrict`, and do not persist the key before the post — either change trades a duplicate for a dropped entry.** True exactly-once needs a client-supplied idempotency key on `addEntry()` that BS deduplicates on; that is a Backend-Service enhancement, tracked in [WXYC/Backend-Service#1545](https://github.com/WXYC/Backend-Service/issues/1545).

## Layout

| Path               | Role                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `src/config.ts`    | zod env schema, fail-fast at boot                                                        |
| `src/core/`        | pure reducer, conflict/breakpoint logic, state model, selectors, coordinator             |
| `src/azuracast/`   | Centrifugo subscriber (`centrifuge` + `ws`) + HTTP poll fallback; pure `parse.ts`        |
| `src/backend/`     | token manager (service-account sign-in + refresh), flowsheet client, pure `map-track.ts` |
| `src/http/`        | Express app, JWKS verifier (`jose`), virtual-switch routes                               |
| `src/persistence/` | restart-recovery snapshot                                                                |
| `src/ports.ts`     | `ArduinoCommandSink` / `DeviceStatusProvider` interfaces (PR B supplies the real ones)   |

## Auth (service account)

`TokenManager` replicates wxyc-canary's `signInDj`: `POST {AUTH_URL}/sign-in/email` (with `Origin: AUTH_TRUSTED_ORIGIN`, which must be in the auth service's `BETTER_AUTH_TRUSTED_ORIGINS`) -> session + `user.id`; then `GET {AUTH_URL}/token` -> JWT. The `dj_id` is the account's **string** `user.id`. Tokens are short-lived; the manager refreshes proactively before `exp` and reactively on a 401, coalescing concurrent refreshes into one round-trip.

## Commands

```bash
npm run dev          # tsx watch
npm run build        # tsc -> dist (excludes *.test.ts)
npm start            # node dist/index.js
npm test             # vitest
npm run typecheck    # tsc --noEmit (covers tests)
npm run format       # prettier --write
```

## Configuration

All env vars are documented in `.env.example` and validated by `src/config.ts` at boot (any missing/invalid value aborts startup). Key groups: server/CORS, Arduino `AUTO_DJ_KEY`, AzuraCast URLs + station shortcode, Backend-Service URL + auth service URL + Auto-DJ account credentials, JWKS/issuer/audience for verifying dj-site JWTs, and the restart-recovery snapshot path.

## Testing

TDD, pure modules first. `npm test` runs the unit suites (reducer, conflict/breakpoint, parse, map-track, token-manager incl. the refresh-race case, jwks-verifier, codec, device-status, command-queue) plus integration: the coordinator with fakes; a real `ws` "Arduino" client driving the real WS server + orchestrator into a mocked Backend-Service (button → join → ack(`result.active`); relay live-DJ → end); and a real `AzuraCastSubscriber` polling a drivable now-playing server through to a flowsheet entry.

## Management channel (`src/management/`)

The Arduino-facing channel. `ws-server.ts` hosts a WebSocket at `/api/auto-dj/ws` (auth: `X-Auto-DJ-Key` validated on the upgrade, timing-safe), routing inbound frames: heartbeat → device status + relay-derived `RELAY_STATE`; `button_toggle` → toggle + ack with `result.active`; `ack` → resolve the pending command; `error` → log. `arduino-http.ts` is the WiFi HTTP fallback (`POST /heartbeat`, `GET /commands`, `POST /commands/ack`); button presses ride `button_press_count` and toggle when odd. `codec.ts` zod-validates frames; `device-status.ts` projects the status `device` block; `command-queue.ts` is the shared pending-command queue. WS ping/pong keepalive terminates a socket that misses a pong.

`test/mocks/azuracast-mock/` is a dependency-free, drivable now-playing server (control endpoints `POST /__control/track` and `/__control/live`) used by the staging environment. The orchestrator ships as a multi-stage `Dockerfile`.

## Status

- **PR A:** core service — config, AzuraCast subscriber, BS client + token manager, activation reducer + conflict/breakpoint, virtual-switch API, healthcheck.
- **PR B:** management channel (WS server + HTTP fallback), device status, command queue, codec, Dockerfile, drivable AzuraCast mock, end-to-end integration.

## Shared types

Wire contracts come from `@wxyc/shared/auto-dj` (generated from `components/schemas` in wxyc-shared `api.yaml`). `codec.ts` carries a compile-time tie (`_AssertInboundMatchesContract`) that fails the build if the zod validators drift from the published types — with one documented exception: `AutoDJErrorReport.code` is validated as a free string (the contract's closed `AutoDJErrorCode` enum widened) so a version-skew firmware code is logged, not dropped.

`@wxyc/shared` declares `better-auth` as an _optional_ peer, but GitHub Packages strips `peerDependenciesMeta` from its packument, so npm's resolver still treats it as a hard peer and tries to auto-install it — pulling `@tanstack/react-start → vite >=7`, which collides with `vitest`'s vite 5. `.npmrc` sets `legacy-peer-deps=true` to skip peer auto-install; better-auth is auth-client-only and never enters this type-only consumer's tree (verify with `ls node_modules/better-auth` → absent).
