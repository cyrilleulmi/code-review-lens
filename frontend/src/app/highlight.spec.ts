import { describe, expect, it } from 'vitest';
import { DisplayLine } from './api';
import { flattenLines, highlightLines } from './highlight';

function line(type: DisplayLine['type'], text: string, extra: Partial<DisplayLine> = {}): DisplayLine {
  return { type, oldLine: null, newLine: null, key: null, text, own: false, inDiff: false, gapSize: null, refs: null, ...extra };
}

function gap(hidden: DisplayLine[] | null): DisplayLine {
  return line('gap', null as unknown as string, { text: null, gapSize: hidden?.length ?? 5, hidden });
}

const isComment = (html: string) => html.includes('hljs-comment');

describe('highlighting across gaps', () => {
  it('ends a block comment that closes in the hidden lines of a gap', () => {
    const lines = [
      line('ctx', '/**'),
      gap([line('ctx', ' * Doc.'), line('ctx', ' */'), line('ctx', 'class A {')]),
      line('add', '  int x = 1;'),
      line('ctx', '}'),
    ];
    const flat = flattenLines(lines);
    expect(flat.map((f) => f.gap)).toEqual([null, null, 1, 1, 1, null, null]);
    const html = highlightLines(flat.map((f) => f.line), 'java');
    expect(isComment(html[0])).toBe(true);
    expect(isComment(html[5])).toBe(false);
    expect(html[5]).toContain('hljs-type');
  });

  it('starts afresh after a gap whose lines are unknown', () => {
    const html = highlightLines([line('ctx', '/*'), gap(null), line('add', 'int x = 1;')], 'java');
    expect(isComment(html[0])).toBe(true);
    expect(isComment(html[2])).toBe(false);
  });

  it('places nested hidden lines right after their gap', () => {
    const inner = gap([line('ctx', 'b')]);
    const flat = flattenLines([gap([line('ctx', 'a'), inner]), line('ctx', 'c')]);
    expect(flat.map((f) => [f.line.text, f.gap])).toEqual([[null, null], ['a', 0], [null, 0], ['b', 2], ['c', null]]);
  });
});
