import { describe, expect, it } from 'vitest';
import { DisplayLine, Segment } from './api';
import { startOf, wholeBlock, wholeId } from './whole-class';

function line(type: DisplayLine['type'], n: number | null, text: string, extra: Partial<DisplayLine> = {}): DisplayLine {
  const key = type === 'del' ? 'O' + extra.oldLine : 'N' + n;
  return { type, oldLine: null, newLine: n, key, text, own: false, inDiff: false, gapSize: null, refs: null, ...extra };
}

/** The file as the backend sends it: nothing is anybody's own. */
const FILE: DisplayLine[] = [
  line('ctx', 1, 'class A {'),
  line('ctx', 2, '  one() {'),
  line('del', null, '    old();', { oldLine: 3 }),
  line('add', 3, '    two();'),
  line('ctx', 4, '  }'),
  line('ctx', 5, '  untouched() {}'),
  line('ctx', 6, '  two() {'),
  line('add', 7, '    log();'),
  line('ctx', 8, '  }'),
  line('add', 9, '  other() {}'),
  line('ctx', 10, '}'),
];

function step(id: string, startLine: number | null, lines: DisplayLine[]): Segment {
  return {
    id, path: 'src/a.ts', language: 'typescript', kind: 'symbol', symbol: 'A.' + id, symbolKind: 'method', startLine, endLine: null,
    category: 'logic', group: 'a.ts', ruleId: null, reason: '',
    lineKeys: lines.flatMap((l) => [l, ...(l.hidden ?? [])]).filter((l) => l.own).map((l) => l.key!), lines,
    places: ['flows/flow-1'], testedBy: [], layer: null, frontend: true,
  };
}

const ONE = step('one', 2, [
  line('ctx', 2, '  one() {'),
  line('del', null, '    old();', { oldLine: 3, own: true }),
  line('add', 3, '    two();', { own: true, refs: [{ segmentId: 'two', symbol: 'A.two' }] }),
  line('ctx', 4, '  }'),
]);
// its changed line sits in a gap that the block of the step folds away
const TWO = step('two', 6, [
  line('ctx', 6, '  two() {'),
  { type: 'gap', oldLine: null, newLine: null, key: null, text: null, own: false, inDiff: false, gapSize: 1, refs: null, hidden: [line('add', 7, '    log();', { own: true })] },
  line('ctx', 8, '  }'),
]);

describe('whole class', () => {
  it('shows every line of the file, changed or not', () => {
    const block = wholeBlock('A', 'src/a.ts', FILE, [TWO, ONE]);
    expect(block.segment.lines.map((l) => l.text)).toEqual(FILE.map((l) => l.text));
    expect(block.segment.lines.some((l) => l.type === 'gap')).toBe(false);
    expect(block.segment.id).toBe(wholeId('src/a.ts'));
    expect(block.segment.symbol).toBe('A');
  });

  it('marks the changes of the steps as own, also those folded away in the block of the step', () => {
    const block = wholeBlock('A', 'src/a.ts', FILE, [ONE, TWO]);
    expect(block.segment.lines.filter((l) => l.own).map((l) => l.key)).toEqual(['O3', 'N3', 'N7']);
    expect(block.segment.lineKeys).toEqual(['O3', 'N3', 'N7']);
  });

  it('leaves a change of no step of the flow to others', () => {
    const block = wholeBlock('A', 'src/a.ts', FILE, [ONE, TWO]);
    const other = block.segment.lines.find((l) => l.key === 'N9')!;
    expect(other.type).toBe('add');
    expect(other.own).toBe(false);
    expect(block.owners.has('N9')).toBe(false);
  });

  it('keeps the calls of a step and knows which step a line belongs to', () => {
    const block = wholeBlock('A', 'src/a.ts', FILE, [ONE, TWO]);
    expect(block.segment.lines.find((l) => l.key === 'N3')!.refs).toEqual([{ segmentId: 'two', symbol: 'A.two' }]);
    expect(block.owners.get('N3')).toBe('one');
    expect(block.owners.get('N8')).toBe('two');
    expect(block.owners.has('N5')).toBe(false);
  });

  it('lists the steps in file order with the line they start at', () => {
    const block = wholeBlock('A', 'src/a.ts', FILE, [TWO, ONE]);
    expect(block.parts).toEqual(['one', 'two']);
    expect([...block.starts]).toEqual([[2, 'one'], [6, 'two']]);
  });

  it('starts a step without a symbol at its first numbered line', () => {
    expect(startOf(step('hunk', null, [line('del', null, 'x', { oldLine: 4 }), line('add', 12, 'y')]))).toBe(12);
  });
});
