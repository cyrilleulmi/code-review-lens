import { describe, expect, it } from 'vitest';
import { InlineStep, classLinks, classOf, classRuns, codeLevelFor, groupByClass, inFileOrder, inlineTree, intersect, shortName, stepName, weakest } from './flow-classes';

/** "View.save" -> class View; steps given as [id, depth, caller]. */
const step = (id: string, depth: number, caller: string | null) => ({ step: { segmentId: id }, depth, caller });
const byPrefix = (id: string) => ({ key: id.split('.')[0], name: id.split('.')[0] });

describe('classOf', () => {
  it('takes the component of the segment', () => {
    expect(classOf({ path: 'src/app/player-view.html' }, { id: 'src/app/player-view', name: 'PlayerView' }))
      .toEqual({ key: 'src/app/player-view', name: 'PlayerView' });
  });

  it('falls back to the file without its extension', () => {
    expect(classOf({ path: 'api/PlayerResource.java' }, undefined)).toEqual({ key: 'api/PlayerResource', name: 'PlayerResource' });
    expect(classOf({ path: 'Makefile' }, undefined)).toEqual({ key: 'Makefile', name: 'Makefile' });
  });
});

describe('shortName and stepName', () => {
  it('keep the class and the name of a step', () => {
    expect(shortName('api.PlayerResource.update')).toBe('PlayerResource.update');
    expect(shortName('byName')).toBe('byName');
    expect(stepName({ symbol: 'PlayerResource.update', path: 'api/PlayerResource.java' }, 's1')).toBe('PlayerResource.update');
    expect(stepName({ symbol: null, path: 'app/player-view.html' }, 's2')).toBe('player-view.html');
    expect(stepName(undefined, 's3')).toBe('s3');
  });
});

describe('groupByClass', () => {
  it('combines the steps of a class in the order the classes are first reached', () => {
    const groups = groupByClass([
      step('View.save', 0, null),
      step('Api.set', 1, 'View.save'),
      step('Resource.update', 2, 'Api.set'),
      step('Resource.validate', 3, 'Resource.update'),
      step('Resource.inRange', 4, 'Resource.validate'),
      step('Player.isTaken', 4, 'Resource.validate'),
    ], byPrefix);

    expect(groups.map((g) => [g.key, g.members.map((m) => m.step.segmentId), g.depth, g.caller])).toEqual([
      ['View', ['View.save'], 0, null],
      ['Api', ['Api.set'], 1, 'View'],
      ['Resource', ['Resource.update', 'Resource.validate', 'Resource.inRange'], 2, 'Api'],
      ['Player', ['Player.isTaken'], 3, 'Resource'],
    ]);
  });

  it('keeps a class where it was first reached when it is called back later', () => {
    const groups = groupByClass([
      step('A.run', 0, null),
      step('B.work', 1, 'A.run'),
      step('A.done', 2, 'B.work'),
      step('C.log', 3, 'A.done'),
    ], byPrefix);

    expect(groups.map((g) => [g.key, g.depth, g.caller])).toEqual([['A', 0, null], ['B', 1, 'A'], ['C', 1, 'A']]);
    expect(groups[0].members.map((m) => m.step.segmentId)).toEqual(['A.run', 'A.done']);
  });

  it('makes every entry point a root', () => {
    const groups = groupByClass([step('A.run', 0, null), step('B.other', 0, null)], byPrefix);

    expect(groups.map((g) => [g.key, g.depth, g.caller])).toEqual([['A', 0, null], ['B', 0, null]]);
  });
});

describe('classRuns', () => {
  it('cuts the steps into runs of consecutive steps of one class, in call order', () => {
    const runs = classRuns([
      step('View.save', 0, null),
      step('Resource.update', 1, 'View.save'),
      step('Resource.validate', 2, 'Resource.update'),
      step('Player.isTaken', 3, 'Resource.validate'),
      step('Resource.inRange', 3, 'Resource.validate'),
    ], byPrefix);

    expect(runs.map((r) => [r.key, r.members.map((m) => m.step.segmentId), r.depth])).toEqual([
      ['View', ['View.save'], 0],
      ['Resource', ['Resource.update', 'Resource.validate'], 1],
      ['Player', ['Player.isTaken'], 3],
      ['Resource', ['Resource.inRange'], 3],
    ]);
  });
});

describe('codeLevelFor', () => {
  it('lets the code follow the diagram: classes for classes, methods for methods and for the combined diagram', () => {
    expect(codeLevelFor('class')).toBe('class');
    expect(codeLevelFor('method')).toBe('method');
    expect(codeLevelFor('combined')).toBe('method');
  });
});

describe('classLinks', () => {
  const keyOf = (id: string) => (id.startsWith('Hidden') ? undefined : id.split('.')[0]);

  it('combines the calls between two classes and leaves out calls within a class', () => {
    const links = classLinks([
      { from: 'A.run', to: 'B.work' },
      { from: 'B.work', to: 'B.helper' },
      { from: 'A.done', to: 'B.helper' },
      { from: 'B.work', to: 'A.done' },
    ], keyOf);

    expect(links.map((l) => [l.from, l.to, l.edges.length])).toEqual([['A', 'B', 2], ['B', 'A', 1]]);
  });

  it('leaves out calls with an end that is not shown', () => {
    expect(classLinks([{ from: 'A.run', to: 'Hidden.x' }, { from: 'Hidden.x', to: 'B.work' }], keyOf)).toEqual([]);
  });
});

describe('inFileOrder', () => {
  it('sorts the steps of a class by file and line', () => {
    const member = (id: string, path: string, startLine: number | null) => ({ id, segment: { path, startLine } });
    const sorted = inFileOrder([member('c', 'b.ts', 5), member('a', 'a.ts', 40), member('x', 'a.ts', null), member('b', 'a.ts', 7)]);

    expect(sorted.map((m) => m.id)).toEqual(['b', 'a', 'x', 'c']);
  });
});

describe('weakest', () => {
  it('takes the weakest status present', () => {
    const order = ['none', 'mocked', 'tested'] as const;
    expect(weakest(['tested', 'mocked', 'tested'], order)).toBe('mocked');
    expect(weakest(['tested', null, 'none'], order)).toBe('none');
    expect(weakest(['tested', 'tested'], order)).toBe('tested');
    expect(weakest([null, undefined], order)).toBeNull();
  });
});

describe('intersect', () => {
  it('keeps what is in every set', () => {
    expect([...intersect([new Set(['a', 'b', 'c']), new Set(['b', 'c']), new Set(['c', 'd'])])]).toEqual(['c']);
    expect([...intersect([])]).toEqual([]);
  });
});

describe('inlineTree', () => {
  const shape = (nodes: InlineStep[]): unknown[] => nodes.map((n) => [n.id, n.line, ...(n.cut ? ['cut'] : []), shape(n.children)]);
  const steps = (...ids: [string, string | null][]) => ids.map(([id, caller]) => ({ id, caller }));

  it('places every called step after the line that calls it, in line order', () => {
    const tree = inlineTree(steps(['a', null], ['b', 'a'], ['c', 'b'], ['d', 'a']), [
      { from: 'a', to: 'd', line: 30 },
      { from: 'a', to: 'b', line: 12 },
      { from: 'b', to: 'c', line: 5 },
    ]);

    expect(shape(tree)).toEqual([['a', null, [['b', 12, [['c', 5, []]]], ['d', 30, []]]]]);
  });

  it('shows a step at every line that calls it', () => {
    const tree = inlineTree(steps(['a', null], ['b', 'a'], ['c', 'a']), [
      { from: 'a', to: 'b', line: 3 },
      { from: 'a', to: 'c', line: 5 },
      { from: 'b', to: 'c', line: 9 },
      { from: 'a', to: 'c', line: 7 },
    ]);

    expect(shape(tree)).toEqual([['a', null, [['b', 3, [['c', 9, []]]], ['c', 5, []], ['c', 7, []]]]]);
    const keys = tree[0].children.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves out a call back into a step that is open further up', () => {
    const tree = inlineTree(steps(['a', null], ['b', 'a']), [{ from: 'a', to: 'b', line: 3 }, { from: 'b', to: 'a', line: 8 }]);

    expect(shape(tree)).toEqual([['a', null, [['b', 3, []]]]]);
  });

  it('puts a step without a calling line after the code of its caller', () => {
    const tree = inlineTree(steps(['a', null], ['b', 'a'], ['c', 'a']), [{ from: 'a', to: 'b', line: 3 }]);

    expect(shape(tree)).toEqual([['a', null, [['b', 3, []], ['c', null, []]]]]);
  });

  it('ignores calls to steps that are not shown and keeps several entry points', () => {
    const tree = inlineTree(steps(['a', null], ['x', null]), [{ from: 'a', to: 'gone', line: 3 }]);

    expect(shape(tree)).toEqual([['a', null, []], ['x', null, []]]);
  });

  it('does not unfold a step again once the limit is reached', () => {
    const tree = inlineTree(steps(['a', null], ['b', 'a'], ['c', 'b']), [
      { from: 'a', to: 'b', line: 1 },
      { from: 'a', to: 'b', line: 2 },
      { from: 'b', to: 'c', line: 1 },
    ], 3);

    expect(shape(tree)).toEqual([['a', null, [['b', 1, [['c', 1, []]]], ['b', 2, 'cut', []]]]]);
  });
});
