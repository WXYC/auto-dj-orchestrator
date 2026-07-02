/**
 * Pure parse/serialize for the Arduino management channel. Inbound frames are
 * zod-validated against the AutoDJ message union (networking-spec §3.6.2);
 * malformed/unknown frames parse to null and are dropped.
 */
import { z } from 'zod';
import type { AutoDJErrorReport, AutoDJWebSocketMessage } from '@wxyc/shared/auto-dj';

const stateEnum = z.enum(['BOOTING', 'CONNECTING', 'CONNECTED', 'ERROR_STATE']);

const heartbeat = z.object({
  type: z.literal('heartbeat'),
  state: stateEnum,
  transport: z.enum(['ethernet', 'wifi']),
  uptime_s: z.number(),
  wifi_rssi: z.number().nullish(),
  free_ram: z.number(),
  radio_show_id: z.number().nullish(),
  last_track: z.object({ artist: z.string(), title: z.string(), posted_at: z.number() }).optional(),
  last_error: z.string().nullish(),
  firmware_version: z.string(),
  config_hash: z.string(),
  loop_max_ms: z.number(),
  reconnect_count: z.number(),
  tracks_detected: z.number(),
  tracks_posted: z.number(),
  errors_since_boot: z.number(),
  button_press_count: z.number().optional(),
  relay_auto_dj_active: z.boolean().optional(),
});

const ack = z.object({
  type: z.literal('ack'),
  id: z.string(),
  status: z.enum(['ok', 'error', 'unknown_command']),
  error: z.string().optional(),
  result: z.record(z.unknown()).optional(),
});

const buttonToggle = z.object({
  type: z.literal('button_toggle'),
  timestamp: z.number(),
});

const errorReport = z.object({
  type: z.literal('error'),
  level: z.enum(['warning', 'error', 'fatal']),
  module: z.string(),
  code: z.string(),
  message: z.string(),
  state: stateEnum,
  uptime_s: z.number(),
  free_ram: z.number(),
  count: z.number(),
});

/** Messages the Arduino sends to the orchestrator. (It never sends now_playing —
 *  the orchestrator subscribes to AzuraCast itself.) */
const inbound = z.discriminatedUnion('type', [heartbeat, ack, buttonToggle, errorReport]);

export type InboundMessage = z.infer<typeof inbound>;

// Compile-time tie to the wire contract (@wxyc/shared/auto-dj): every inbound
// variant must be assignable to AutoDJWebSocketMessage, so a future contract
// change these zod schemas don't track fails the build instead of silently
// dropping real Arduino frames at runtime. The one deliberate exception is
// AutoDJErrorReport.code: the contract types it as the closed AutoDJErrorCode
// enum, but we validate it as a free string so a version-skew code from the
// firmware is logged rather than dropped — an error report is exactly the frame
// we least want to lose. So we compare against the contract with code widened.
type InboundContractMessage =
  | Exclude<AutoDJWebSocketMessage, AutoDJErrorReport>
  | (Omit<AutoDJErrorReport, 'code'> & { code: string });
type _AssertInboundMatchesContract = InboundMessage extends InboundContractMessage ? true : never;
const _inboundContractTie: _AssertInboundMatchesContract = true;
void _inboundContractTie;

/** Validate an already-parsed value (HTTP bodies arrive pre-parsed by express.json). */
export function validateInbound(value: unknown): InboundMessage | null {
  const result = inbound.safeParse(value);
  return result.success ? result.data : null;
}

/** Parse a raw frame (WS), returning null if it is not a valid inbound message. */
export function parseInbound(raw: string): InboundMessage | null {
  try {
    return validateInbound(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serialize(message: AutoDJWebSocketMessage): string {
  return JSON.stringify(message);
}
