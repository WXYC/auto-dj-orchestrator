# Auto-DJ Orchestrator

Standalone service that bridges WXYC's auto-DJ system (AzuraCast) with the station's flowsheet. When activated by a DJ via the virtual switch in [dj-site](https://github.com/WXYC/dj-site), it subscribes to AzuraCast's now-playing feed and writes entries to the configured flowsheet backend(s).

## Architecture

```
dj-site (virtual switch) --> Orchestrator --> Backend-Service API (PostgreSQL)
                                         \-> tubafrenzy API (MySQL)

Arduino (optional) -.-> Orchestrator (relay state + management)

AzuraCast (Centrifugo WebSocket / HTTP poll) --> Orchestrator
```

### Responsibilities

| Responsibility | Description |
|----------------|-------------|
| **AzuraCast subscription** | Subscribe to AzuraCast's Centrifugo WebSocket (primary) or poll the HTTP now-playing endpoint (fallback). Detect track changes via `sh_id`. |
| **Flowsheet writing** | Write entries to Backend-Service and/or tubafrenzy based on the `FLOWSHEET_BACKEND` flag. |
| **Show lifecycle** | Start/end auto-DJ shows. Insert hourly breakpoint entries. |
| **Virtual switch API** | Expose activation/deactivation/status endpoints called by dj-site. |
| **Arduino management** | Accept heartbeats and relay state reports from the Arduino. Dispatch config commands. WebSocket (primary) + HTTP polling (fallback). |
| **Conflict resolution** | Auto-deactivate when a live DJ starts a show. Detect orphaned shows on restart. |

### Dual-Backend Targeting

A `FLOWSHEET_BACKEND` environment variable determines where entries are written:

| Flag | Behavior |
|------|----------|
| `BACKEND_SERVICE` | Write to Backend-Service's flowsheet API (JSON + Bearer token) **and** mirror to tubafrenzy (form-encoded + `X-Auto-DJ-Key`). |
| `TUBAFRENZY` | Write to tubafrenzy only (form-encoded + `X-Auto-DJ-Key`). Current production behavior, minus the Arduino. |

This is the server-side equivalent of the Arduino's original `FlowsheetBackend` abstraction.

## Specification

The full networking specification lives in the [auto-dj-arduino-switch](https://github.com/WXYC/auto-dj-arduino-switch) repo:

- [**docs/networking-spec.md**](https://github.com/WXYC/auto-dj-arduino-switch/blob/main/docs/networking-spec.md) -- all network traffic, protocols, authentication, type contracts, and implementation phases

Key sections for the orchestrator:

| Section | Content |
|---------|---------|
| 2.1 Network Topology | System diagram showing the orchestrator's role |
| 2.2 Virtual Switch Activation | Activation/deactivation flow |
| 2.3 Conflict Resolution | How live DJ shows auto-deactivate auto-DJ |
| 2.6 Dual-Database Architecture | `FLOWSHEET_BACKEND` flag and write paths |
| 3.2-3.3 | AzuraCast HTTP polling and Centrifugo WebSocket protocols |
| 3.4 | Auto-DJ activation API specification |
| 3.5 | Flowsheet write pipeline |
| 3.8-3.9 | Arduino management channel (WebSocket + HTTP fallback) |
| 6 | Orchestrator module architecture and testing strategy |

## Tech Stack

- **Runtime**: Node.js / TypeScript
- **AzuraCast client**: `centrifuge-js` (Centrifugo WebSocket) + `fetch` (HTTP polling fallback)
- **Auth**: Better Auth PAT for Backend-Service API; `X-Auto-DJ-Key` for tubafrenzy; JWT/JWKS validation (via `jose`) for admin endpoints
- **Deployment**: Railway (`main` -> staging, `prod` -> production)
- **Types**: `@wxyc/shared/auto-dj` for shared type contracts

## Related Repositories

| Repo | Relationship |
|------|-------------|
| [auto-dj-arduino-switch](https://github.com/WXYC/auto-dj-arduino-switch) | Arduino hardware (optional relay reporter). Networking spec lives here. |
| [Backend-Service](https://github.com/WXYC/Backend-Service) | Flowsheet API + auth. One of the orchestrator's write targets. |
| [dj-site](https://github.com/WXYC/dj-site) | Frontend. Hosts the virtual switch that activates/deactivates the orchestrator. |
| [tubafrenzy](https://github.com/WXYC/tubafrenzy) | Legacy flowsheet system. The other write target (and mirror target when `FLOWSHEET_BACKEND=BACKEND_SERVICE`). |
| [wxyc-shared](https://github.com/WXYC/wxyc-shared) | Shared DTOs and type contracts (`@wxyc/shared/auto-dj`). |
