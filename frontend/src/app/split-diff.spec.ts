import { describe, expect, it } from 'vitest';
import { diffSides, pairLines } from './split-diff';

const lines = (types: string) => [...types].map((c) => ({ type: c === '-' ? 'del' : c === '+' ? 'add' : c === '~' ? 'gap' : 'ctx' }));

describe('pairLines', () => {
  it('puts context lines on both sides', () => {
    expect(pairLines(lines('  '))).toEqual([{ left: 0, right: 0 }, { left: 1, right: 1 }]);
  });

  it('puts the n-th deleted line next to the n-th added line of a run', () => {
    expect(pairLines(lines(' --++ '))).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 3 },
      { left: 2, right: 4 },
      { left: 5, right: 5 },
    ]);
  });

  it('leaves the other side empty for what is left over', () => {
    expect(pairLines(lines('---+'))).toEqual([{ left: 0, right: 3 }, { left: 1, right: null }, { left: 2, right: null }]);
    expect(pairLines(lines('-++'))).toEqual([{ left: 0, right: 1 }, { left: null, right: 2 }]);
  });

  it('keeps pure additions and pure deletions on their side', () => {
    expect(pairLines(lines('++'))).toEqual([{ left: null, right: 0 }, { left: null, right: 1 }]);
    expect(pairLines(lines('--'))).toEqual([{ left: 0, right: null }, { left: 1, right: null }]);
  });

  it('ends a run at context lines and gaps', () => {
    expect(pairLines(lines('- +~-+'))).toEqual([
      { left: 0, right: null },
      { left: 1, right: 1 },
      { left: null, right: 2 },
      { left: 3, right: 3 },
      { left: 4, right: 5 },
    ]);
  });
});

describe('diffSides', () => {
  it('has both sides when lines were removed and added', () => {
    expect(diffSides(lines('-+'))).toBe('both');
    expect(diffSides(lines(' - ~+'))).toBe('both');
  });

  it('has one side for a block with only added or only removed lines, unchanged lines or not', () => {
    expect(diffSides(lines('++~+'))).toBe('new');
    expect(diffSides(lines(' + '))).toBe('new');
    expect(diffSides(lines('--'))).toBe('old');
    expect(diffSides(lines(' -'))).toBe('old');
    expect(diffSides(lines('  '))).toBe('none');
  });

  it('reads the lines hidden in gaps', () => {
    expect(diffSides([{ type: 'del' }, { type: 'gap', hidden: [{ type: 'ctx' }, { type: 'add' }] }])).toBe('both');
  });
});
