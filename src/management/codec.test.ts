import { describe, it, expect } from 'vitest';
import { parseInbound, validateInbound, serialize } from './codec.js';

const heartbeat = {
  type: 'heartbeat',
  state: 'CONNECTED',
  transport: 'ethernet',
  uptime_s: 10,
  free_ram: 500000,
  firmware_version: '2.0.0',
  config_hash: 'abc',
  loop_max_ms: 5,
  reconnect_count: 0,
  tracks_detected: 0,
  tracks_posted: 0,
  errors_since_boot: 0,
  relay_auto_dj_active: true,
};

describe('codec', () => {
  it('parses a valid heartbeat frame', () => {
    const msg = parseInbound(JSON.stringify(heartbeat));
    expect(msg?.type).toBe('heartbeat');
    expect(msg && msg.type === 'heartbeat' && msg.relay_auto_dj_active).toBe(true);
  });

  it('parses button_toggle, ack, and error frames', () => {
    expect(parseInbound('{"type":"button_toggle","timestamp":123}')?.type).toBe('button_toggle');
    expect(parseInbound('{"type":"ack","id":"cmd_1","status":"ok"}')?.type).toBe('ack');
    expect(
      parseInbound(
        '{"type":"error","level":"error","module":"mgmt_client","code":"WS_DISCONNECT","message":"x","state":"CONNECTING","uptime_s":1,"free_ram":1,"count":1}',
      )?.type,
    ).toBe('error');
  });

  it('returns null for malformed JSON and unknown types', () => {
    expect(parseInbound('not json')).toBeNull();
    expect(parseInbound('{"type":"bogus"}')).toBeNull();
    expect(parseInbound('{"type":"heartbeat"}')).toBeNull(); // missing required fields
  });

  it('validateInbound accepts a pre-parsed object', () => {
    expect(validateInbound(heartbeat)?.type).toBe('heartbeat');
    expect(validateInbound({ nope: true })).toBeNull();
  });

  it('serialize round-trips a command', () => {
    expect(JSON.parse(serialize({ type: 'command', id: 'cmd_1', action: 'pause' }))).toEqual({
      type: 'command',
      id: 'cmd_1',
      action: 'pause',
    });
  });
});
