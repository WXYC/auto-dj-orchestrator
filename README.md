# Auto-DJ Orchestrator

Standalone Node/TypeScript service that bridges WXYC's auto-DJ system (AzuraCast) with the station's flowsheet. When activated by a DJ via the virtual switch in [dj-site](https://github.com/WXYC/dj-site) or the physical button on the Arduino, it subscribes to AzuraCast's now-playing feed and writes entries to Backend-Service.

It is the single brain of the auto-DJ system: it owns activation state, conflict resolution, the AzuraCast subscription, all flowsheet writes, hourly breakpoints, the dj-site virtual switch API, and the Arduino management channel.

## Architecture

```
dj-site (virtual switch) --> Orchestrator --(dj-role JWT)--> Backend-Service --mirror--> tubafrenzy
                                  |
Arduino (relay + button) --(WS mgmt channel + HTTP fallback)--> Orchestrator
                                  |
AzuraCast (Centrifugo WebSocket / HTTP poll) --> Orchestrator
```

The orchestrator writes **only to Backend-Service**, which mirrors every flowsheet write to legacy tubafrenzy automatically — so there is no direct-tubafrenzy path and no dual-backend flag. It authenticates as the **Auto-DJ service account** (a `dj`-role Better-Auth user) and creates the show AS that account (BS enforces `dj_id === req.auth.id`).

The Arduino is a "dumb" relay/button reporter: it reports relay state and button presses over the management channel but does not talk to AzuraCast or write flowsheets. Every activation decision lives in the orchestrator.

### Responsibilities

| Responsibility             | Description                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **AzuraCast subscription** | Subscribe to AzuraCast's Centrifugo WebSocket (primary) or poll the HTTP now-playing endpoint (fallback). Detect track changes via `sh_id`. |
| **Flowsheet writing**      | Write entries to Backend-Service (which mirrors to tubafrenzy). Post hourly breakpoint markers (BS does not auto-insert them).              |
| **Show lifecycle**         | Start/end auto-DJ shows as the Auto-DJ service account.                                                                                     |
| **Virtual switch API**     | Expose activate / deactivate / status endpoints called by dj-site (`/api/auto-dj/*`).                                                       |
| **Arduino management**     | Accept heartbeats, relay state, and button presses from the Arduino; dispatch commands. WebSocket (primary) + HTTP fallback.                |
| **Conflict resolution**    | Auto-deactivate when a live DJ starts a show; no auto-reactivation; detect orphaned shows on restart.                                       |

### Flowsheet posting guarantee

Now-playing entries are posted to Backend-Service **at least once**: the orchestrator advances its durable dedupe key (the last-posted AzuraCast `sh_id`) only _after_ BS accepts an entry, so a failed post is retried on the next tick rather than being recorded as sent and dropped. The guarantee is therefore **no dropped entries**, at the cost of a narrow crash window — if `addEntry()` succeeds in BS but the process dies before the dedupe-key persist, the restart re-posts that one track. So: at-least-once, with **at most one duplicate on an ill-timed crash**, never a drop. Reaching true exactly-once needs a client-supplied idempotency key that BS deduplicates on, tracked in [WXYC/Backend-Service#1545](https://github.com/WXYC/Backend-Service/issues/1545).

## Specification

The full networking specification lives in the [auto-dj-arduino-switch](https://github.com/WXYC/auto-dj-arduino-switch) repo:

- [**docs/networking-spec.md**](https://github.com/WXYC/auto-dj-arduino-switch/blob/main/docs/networking-spec.md) — all network traffic, protocols, authentication, and type contracts.

Key sections for the orchestrator:

| Section                | Content                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| 2.1 Network Topology   | System diagram showing the orchestrator's role                            |
| 2.7 Activation Sources | Relay/button/virtual switch and the conflict-resolution rules             |
| 3.2, 3.9               | AzuraCast HTTP polling and Centrifugo WebSocket protocols                 |
| 3.4                    | Backend-Service flowsheet operations (join/entry/breakpoint/end)          |
| 3.6–3.8                | Arduino management channel (WebSocket + HTTP fallback + server endpoints) |
| 3.10                   | Virtual switch API (activate/deactivate/status)                           |
| 5.2                    | `AutoDJ*` type contracts                                                  |

## Provisioning Prerequisites

The orchestrator requires these external resources to be in place before deployment:

### 1. Auto-DJ service account

A Better-Auth user (`auto-dj@wxyc.org` by default) with the `dj` **org-member role** in Backend-Service. This account writes flowsheet entries; its JWT authority is scoped to exactly what a DJ can do — no more.

- **Role:** `dj` (org member). Deliberately NOT `stationManager`, `admin`, or `owner`. The global `user.role` stays `null` — the account cannot act as a Better-Auth admin.
- **Handle:** `djName: "Auto DJ"` (the on-air name shown on the flowsheet). PII fields are empty — there is no person behind this account.
- **Provisioning:** Backend-Service self-provisions the account via an idempotent startup bootstrap (`createAutoDjUser()`), gated by **two env flags on the BS side**: `CREATE_AUTO_DJ_USER=TRUE` (opt-in gate) and `DEFAULT_ORG_SLUG` (the org must already exist). If either is unset, the bootstrap silently no-ops. Self-signup is disabled (`disableSignUp: true`) and the `/auth/admin/provision-user` endpoint rejects caller-supplied passwords, so the bootstrap is the only viable path.
- **Password:** `AUTO_DJ_PASSWORD`, stored as a per-environment deploy secret. **Must be distinct between staging and prod.** Never committed to source.

### 2. Trusted origin

`AUTH_TRUSTED_ORIGIN` (this service's public URL) must be present in Backend-Service's `BETTER_AUTH_TRUSTED_ORIGINS` environment variable. Without it, the `POST /auth/sign-in/email` call is rejected with 403.

### 3. AzuraCast station shortcode

`AZURACAST_STATION_SHORTCODE` must match the live AzuraCast station. The Centrifugo WebSocket channel is `station:<shortcode>`. Verify before deploying to prod:

```bash
curl https://remote.wxyc.org/api/nowplaying/<shortcode>
# Must return a single station JSON object whose station.shortcode matches.
# An array response means the shortcode is wrong (AzuraCast returns 200 either way).
```

A wrong shortcode silently degrades to HTTP polling only (functional but higher latency; no Centrifugo push). Note: the WXYC station is **named** "wxyc" but its shortcode is `main` — see #33.

### Boot-time preflight

The orchestrator runs a non-fatal preflight check at startup (`src/preflight.ts`) that verifies:

- The AzuraCast shortcode resolves to a real station (not the all-stations fallback)

Auth/account issues are not checked at preflight — TokenManager's first sign-in handles those seconds later with proper retry-after backoff and clear log messages. Preflight targets the one misconfiguration that fails **silently** (wrong shortcode degrades to HTTP polling with no error).

Preflight failures are logged as warnings, not fatal errors, so local dev and CI aren't blocked by missing external services.

## Tech Stack

- **Runtime**: Node.js 24 / TypeScript (ESM)
- **HTTP/WS**: Express 5 + `ws` (Arduino-facing management channel)
- **AzuraCast client**: `centrifuge` (Centrifugo WebSocket) + `fetch` (HTTP polling fallback)
- **Auth**: Better-Auth JWT service account (sign-in + refresh) for the Backend-Service API; `jose` JWKS validation for the dj-site virtual-switch endpoints; `X-Auto-DJ-Key` for the Arduino channel
- **Deployment**: Railway (`main` -> staging, `prod` -> production)
- **Types**: `@wxyc/shared/auto-dj`

See [CLAUDE.md](CLAUDE.md) for the module layout, core design (pure reducer + impure coordinator), and testing.

## Related Repositories

| Repo                                                                     | Relationship                                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [auto-dj-arduino-switch](https://github.com/WXYC/auto-dj-arduino-switch) | Arduino relay/button reporter. Networking spec lives here.                          |
| [Backend-Service](https://github.com/WXYC/Backend-Service)               | Flowsheet API + auth. The orchestrator's sole write target (mirrors to tubafrenzy). |
| [dj-site](https://github.com/WXYC/dj-site)                               | Frontend. Hosts the virtual switch and reflects auto-DJ state (greyscale + banner). |
| [tubafrenzy](https://github.com/WXYC/tubafrenzy)                         | Legacy flowsheet system. Receives mirrored writes from Backend-Service.             |
| [wxyc-shared](https://github.com/WXYC/wxyc-shared)                       | Shared DTOs and type contracts (`@wxyc/shared/auto-dj`).                            |
