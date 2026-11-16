import { describe, expect, it } from 'vitest';
import { outsideBranch, sameSet, withoutAreas } from './flow-focus';

// component (frontend) → api → service (logic) → repo (data); component → helper (frontend)
const AREA_STEPS = [
  { id: 'component', area: 'frontend', depth: 0, parent: null },
  { id: 'api', area: 'api', depth: 1, parent: 'component' },
  { id: 'service', area: 'logic', depth: 2, parent: 'api' },
  { id: 'repo', area: 'data', depth: 3, parent: 'service' },
  { id: 'helper', area: 'frontend', depth: 1, parent: 'component' },
].map((s) => ({ step: { segmentId: s.id, depth: s.depth, parentSegmentId: s.parent }, area: s.area }));

const shape = (steps: ReturnType<typeof withoutAreas>) => steps.map((s) => [s.step.segmentId, s.depth, s.caller, s.skipped.join()]);

describe('flow areas', () => {
  it('keeps the flow as it is when no area is removed', () => {
    expect(shape(withoutAreas(AREA_STEPS, new Set()))).toEqual([
      ['component', 0, null, ''], ['api', 1, 'component', ''], ['service', 2, 'api', ''], ['repo', 3, 'service', ''], ['helper', 1, 'component', ''],
    ]);
  });

  it('bridges a removed area in the middle and moves the steps behind it up', () => {
    expect(shape(withoutAreas(AREA_STEPS, new Set(['api'])))).toEqual([
      ['component', 0, null, ''], ['service', 1, 'component', 'api'], ['repo', 2, 'service', ''], ['helper', 1, 'component', ''],
    ]);
  });

  it('names every area skipped once and makes steps without a caller left roots', () => {
    expect(shape(withoutAreas(AREA_STEPS, new Set(['frontend', 'api', 'logic'])))).toEqual([['repo', 0, null, 'logic,api,frontend']]);
  });
});

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
