/**
 * Auto-DJ wire contracts.
 *
 * Vendored copy of the `@wxyc/shared/auto-dj` type surface (generated from
 * api.yaml, networking-spec.md §5.2). Kept local so the orchestrator isn't
 * blocked on the shared-package publish; swap these for
 * `import { ... } from '@wxyc/shared/auto-dj'` once WXYC/wxyc-shared#203 ships,
 * then delete this file.
 */

export type AutoDJState = 'BOOTING' | 'CONNECTING' | 'CONNECTED' | 'ERROR_STATE';
export type AutoDJTransport = 'ethernet' | 'wifi';
export type AutoDJCommandAction =
  'set_config' | 'pause' | 'resume' | 'end_show' | 'restart' | 'ping';
export type AutoDJErrorLevel = 'warning' | 'error' | 'fatal';
export type AutoDJActivationSourceType = 'virtual_switch' | 'button' | 'relay';
export type AutoDJRelayState = 'auto_dj_active' | 'dj_live';

export interface AutoDJLastTrack {
  artist: string;
  title: string;
  posted_at: number;
}

export interface AutoDJHeartbeat {
  type: 'heartbeat';
  state: AutoDJState;
  transport: AutoDJTransport;
  uptime_s: number;
  wifi_rssi?: number | null;
  free_ram: number;
  radio_show_id?: number | null;
  last_track?: AutoDJLastTrack;
  last_error?: string | null;
  firmware_version: string;
  config_hash: string;
  loop_max_ms: number;
  reconnect_count: number;
  tracks_detected: number;
  tracks_posted: number;
  errors_since_boot: number;
  button_press_count?: number;
  relay_auto_dj_active?: boolean;
}

export interface AutoDJCommand {
  type: 'command';
  id: string;
  action: AutoDJCommandAction;
  key?: string;
  value?: string;
}

export interface AutoDJAck {
  type: 'ack';
  id: string;
  status: 'ok' | 'error' | 'unknown_command';
  error?: string;
  result?: Record<string, unknown>;
}

export interface AutoDJNowPlaying {
  type: 'now_playing';
  sh_id: number;
  artist: string;
  title: string;
  album: string;
  is_live: boolean;
}

export interface AutoDJErrorReport {
  type: 'error';
  level: AutoDJErrorLevel;
  module: string;
  code: string;
  message: string;
  state: AutoDJState;
  uptime_s: number;
  free_ram: number;
  count: number;
}

export interface AutoDJButtonToggle {
  type: 'button_toggle';
  timestamp: number;
}

export type AutoDJWebSocketMessage =
  | AutoDJHeartbeat
  | AutoDJCommand
  | AutoDJAck
  | AutoDJNowPlaying
  | AutoDJErrorReport
  | AutoDJButtonToggle;

// ── Virtual switch API ───────────────────────────────────────────────────
export interface AutoDJActivationSource {
  source: AutoDJActivationSourceType;
  userId?: string;
  userName?: string;
  detail?: string;
}

export interface AutoDJCurrentTrack {
  artist: string;
  title: string;
  album: string;
  detectedAt: string;
}

export interface AutoDJDeviceSummary {
  online: boolean;
  transport: AutoDJTransport;
  lastHeartbeat: string;
  relayState: AutoDJRelayState;
}

export interface AutoDJStatus {
  active: boolean;
  activatedBy?: AutoDJActivationSource;
  activatedAt?: string;
  showId?: number;
  currentTrack?: AutoDJCurrentTrack | null;
  lastDeactivatedAt?: string;
  lastDeactivatedBy?: AutoDJActivationSource;
  device?: AutoDJDeviceSummary | null;
}

export interface AutoDJDeactivateResponse {
  active: false;
  deactivatedBy: AutoDJActivationSource;
  deactivatedAt: string;
}
