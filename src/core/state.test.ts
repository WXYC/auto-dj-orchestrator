import { describe, expect, it } from 'vitest';
import { initialState, isActive, type Phase } from './state.js';

describe('isActive', () => {
  const withPhase = (phase: Phase) => ({ ...initialState, phase });

  // The two terminal-ish "on the air" phases.
  it('is true when ACTIVE', () => {
    expect(isActive(withPhase('ACTIVE'))).toBe(true);
  });

  it('is true during the ACTIVATING window', () => {
    expect(isActive(withPhase('ACTIVATING'))).toBe(true);
  });

  // Sentinel (item 6): a failed teardown now *stays* DEACTIVATING while the show
  // is still live in BS, so status must read "on the air, teardown pending". This
  // guards the two codified-bug test inversions (orchestrator.test.ts) — if item 6
  // regresses, this fails loudly instead of surfacing as a confusing
  // active===false / phase===DEACTIVATING mismatch.
  it('is true during the DEACTIVATING window (show still live until reconcile confirms off-air)', () => {
    expect(isActive(withPhase('DEACTIVATING'))).toBe(true);
  });

  it('is false when INACTIVE', () => {
    expect(isActive(withPhase('INACTIVE'))).toBe(false);
  });
});
