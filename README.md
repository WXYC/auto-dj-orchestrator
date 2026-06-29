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

## Tech Stack

- **Runtime**: Node.js 24 / TypeScript (ESM)
- **HTTP/WS**: Express 5 + `ws` (Arduino-facing management channel)
- **AzuraCast client**: `centrifuge` (Centrifugo WebSocket) + `fetch` (HTTP polling fallback)
- **Auth**: Better-Auth JWT service account (sign-in + refresh) for the Backend-Service API; `jose` JWKS validation for the dj-site virtual-switch endpoints; `X-Auto-DJ-Key` for the Arduino channel
- **Deployment**: Railway (`main` -> staging, `prod` -> production)
- **Types**: `@wxyc/shared/auto-dj` (vendored locally until published)

See [CLAUDE.md](CLAUDE.md) for the module layout, core design (pure reducer + impure coordinator), and testing.

## Related Repositories

| Repo                                                                     | Relationship                                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [auto-dj-arduino-switch](https://github.com/WXYC/auto-dj-arduino-switch) | Arduino relay/button reporter. Networking spec lives here.                          |
| [Backend-Service](https://github.com/WXYC/Backend-Service)               | Flowsheet API + auth. The orchestrator's sole write target (mirrors to tubafrenzy). |
| [dj-site](https://github.com/WXYC/dj-site)                               | Frontend. Hosts the virtual switch and reflects auto-DJ state (greyscale + banner). |
| [tubafrenzy](https://github.com/WXYC/tubafrenzy)                         | Legacy flowsheet system. Receives mirrored writes from Backend-Service.             |
| [wxyc-shared](https://github.com/WXYC/wxyc-shared)                       | Shared DTOs and type contracts (`@wxyc/shared/auto-dj`).                            |
