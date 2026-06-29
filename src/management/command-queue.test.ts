import { describe, it, expect, vi } from 'vitest';
import { CommandQueue } from './command-queue.js';

describe('CommandQueue', () => {
  it('enqueues commands with incrementing ids and notifies the listener', () => {
    const q = new CommandQueue();
    const listener = vi.fn();
    q.setListener(listener);
    q.send('pause');
    q.send('resume');
    expect(q.getPending().map((c) => ({ id: c.id, action: c.action }))).toEqual([
      { id: 'cmd_1', action: 'pause' },
      { id: 'cmd_2', action: 'resume' },
    ]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ack removes a command and updates the pending count', () => {
    const q = new CommandQueue();
    q.send('pause');
    q.send('resume');
    expect(q.pendingCount).toBe(2);
    q.ack('cmd_1');
    expect(q.pendingCount).toBe(1);
    expect(q.getPending()[0].id).toBe('cmd_2');
  });
});
