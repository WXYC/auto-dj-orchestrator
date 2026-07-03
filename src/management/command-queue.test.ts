import { describe, it, expect, vi } from 'vitest';
import { CommandQueue } from './command-queue.js';

describe('CommandQueue', () => {
  it('assigns incrementing ids, notifies the listener, and collapses superseded power commands', () => {
    const q = new CommandQueue();
    const listener = vi.fn();
    q.setListener(listener);
    q.send('pause'); // cmd_1
    q.send('resume'); // cmd_2 supersedes cmd_1 (pause/resume are absolute power states)
    expect(q.getPending().map((c) => ({ id: c.id, action: c.action }))).toEqual([
      { id: 'cmd_2', action: 'resume' },
    ]);
    expect(listener).toHaveBeenCalledTimes(2); // still pushed live on every send
  });

  it('ack removes the surviving command; a stale (collapsed) id is a no-op', () => {
    const q = new CommandQueue();
    q.send('pause'); // cmd_1
    q.send('resume'); // cmd_2 collapses cmd_1
    expect(q.pendingCount).toBe(1);
    expect(q.getPending()[0].id).toBe('cmd_2');
    q.ack('cmd_1'); // already collapsed away: no-op
    expect(q.pendingCount).toBe(1);
    q.ack('cmd_2');
    expect(q.pendingCount).toBe(0);
  });

  it('cannot grow unbounded while the device is offline (power commands collapse to the latest)', () => {
    const q = new CommandQueue();
    for (let i = 0; i < 100; i++) q.send(i % 2 === 0 ? 'pause' : 'resume');
    expect(q.pendingCount).toBe(1);
    expect(q.getPending()[0].action).toBe('resume'); // last write wins
  });

  it('collapse is scoped to power commands: an interleaved non-power command survives', () => {
    const q = new CommandQueue();
    q.send('pause'); // cmd_1 (power)
    q.send('end_show'); // cmd_2 (non-power, non-idempotent — must never be dropped)
    q.send('resume'); // cmd_3 (power) supersedes cmd_1 only
    // pause collapsed; end_show preserved (an unscoped collapse would lose it).
    expect(q.getPending().map((c) => ({ id: c.id, action: c.action }))).toEqual([
      { id: 'cmd_2', action: 'end_show' },
      { id: 'cmd_3', action: 'resume' },
    ]);
  });
});
