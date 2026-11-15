import { describe, expect, it } from 'vitest';
import { ScrollMemory, viewKey } from './scroll-memory';

const PR = { provider: 'github', owner: 'o', repo: 'r', number: 12 };

describe('scroll memory', () => {
  it('keeps one position per view, a new view starts at the top', () => {
    const m = new ScrollMemory();
    m.save(viewKey(PR, { kind: 'flow', id: 'flow-1' }), 800);
    expect(m.positionOf(viewKey(PR, { kind: 'flow', id: 'flow-1' }))).toBe(800);
    expect(m.positionOf(viewKey(PR, { kind: 'flow', id: 'flow-2' }))).toBe(0);
  });

  it('tells views of different kinds and PRs apart', () => {
    expect(viewKey(PR, { kind: 'flow', id: 'x' })).not.toBe(viewKey(PR, { kind: 'group', id: 'x' }));
    expect(viewKey(PR, { kind: 'file', path: 'a.ts' })).not.toBe(viewKey({ ...PR, number: 13 }, { kind: 'file', path: 'a.ts' }));
  });

  it('forgets the oldest views beyond its limit', () => {
    const m = new ScrollMemory(2);
    m.save('a', 1);
    m.save('b', 2);
    m.save('a', 3);
    m.save('c', 4);
    expect(m.positionOf('b')).toBe(0);
    expect(m.positionOf('a')).toBe(3);
    expect(m.positionOf('c')).toBe(4);
  });
});
