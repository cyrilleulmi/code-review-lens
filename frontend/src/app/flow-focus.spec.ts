import { describe, expect, it } from 'vitest';
import { outsideBranch, sameSet } from './flow-focus';

// a → b → c, a → d, e unconnected
const STEPS = ['a', 'b', 'c', 'd', 'e'].map((segmentId) => ({ segmentId }));
const EDGES = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'd' }];

describe('flow focus', () => {
  it('hides everything outside the branch of a step', () => {
    expect([...outsideBranch(STEPS, EDGES, 'b')].sort()).toEqual(['a', 'd', 'e']);
  });

  it('keeps every step a root reaches, also further down', () => {
    expect([...outsideBranch(STEPS, EDGES, 'a')]).toEqual(['e']);
  });

  it('follows cycles without looping', () => {
    expect([...outsideBranch(STEPS, [...EDGES, { from: 'c', to: 'b' }], 'c')].sort()).toEqual(['a', 'd', 'e']);
  });

  it('compares sets regardless of order', () => {
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });
});
