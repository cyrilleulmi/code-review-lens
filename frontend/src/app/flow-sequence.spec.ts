import { describe, expect, it } from 'vitest';
import { SequenceEdge, callStack, entryOf, flowSequence, isUsedNotCalled, sequenceKey } from './flow-sequence';

/** Steps as [id, caller]; edges as [from, to, line(s)]. */
const steps = (...list: [string, string | null][]) => list.map(([segmentId, parentSegmentId]) => ({ segmentId, parentSegmentId }));
const call = (from: string, to: string, lines: number | number[] | null, kind: 'call' | 'http' = 'call'): SequenceEdge => {
  const all = lines == null ? null : Array.isArray(lines) ? lines : [lines];
  return { from, to, line: all?.[0] ?? null, via: to, kind, lines: all };
};
/** "3 a>b@12" per call: number, caller, callee, line. */
const brief = (calls: readonly { no: number; from: string; to: string; line: number | null }[]) =>
  calls.map((c) => `${c.no} ${c.from}>${c.to}@${c.line ?? '-'}`);

describe('flowSequence', () => {
  it('lists the calls from the entry point, each caller line by line, and unfolds what is called', () => {
    const seq = flowSequence(
      steps(['view', null], ['api', 'view'], ['resource', 'api'], ['validate', 'resource'], ['player', 'validate'], ['save', 'resource']),
      [
        call('resource', 'save', 30), // the edges are in no particular order
        call('view', 'api', 12),
        call('api', 'resource', 7, 'http'),
        call('resource', 'validate', 22),
        call('validate', 'player', 41),
      ],
    );

    expect(seq.entries).toEqual([{ id: 'view', after: 0 }]);
    expect(brief(seq.calls)).toEqual(['1 view>api@12', '2 api>resource@7', '3 resource>validate@22', '4 validate>player@41', '5 resource>save@30']);
    expect(seq.calls.map((c) => [c.depth, c.parent, c.end])).toEqual([[0, null, 5], [1, 1, 5], [2, 2, 4], [3, 3, 4], [2, 2, 5]]);
    expect(seq.calls.map((c) => c.http)).toEqual([false, true, false, false, false]);
    // the colour of a call is the colour of its edge of the flow
    expect(seq.calls.map((c) => c.edge)).toEqual([1, 2, 3, 4, 0]);
  });

  it('calls a step once per calling line and unfolds it only the first time', () => {
    const seq = flowSequence(
      steps(['submit', null], ['validate', 'submit'], ['rule', 'validate'], ['persist', 'submit']),
      [call('submit', 'validate', [3, 5]), call('submit', 'persist', 4), call('validate', 'rule', 9)],
    );

    expect(brief(seq.calls)).toEqual(['1 submit>validate@3', '2 validate>rule@9', '3 submit>persist@4', '4 submit>validate@5']);
    expect(seq.calls.map((c) => c.repeatOf)).toEqual([null, null, null, 1]);
    expect(seq.calls[3].end).toBe(4);
  });

  it('lists a step reached on two ways at both, unfolded at the first', () => {
    const seq = flowSequence(
      steps(['a', null], ['b', 'a'], ['shared', 'b'], ['leaf', 'shared'], ['c', 'a']),
      [call('a', 'b', 1), call('a', 'c', 2), call('b', 'shared', 10), call('c', 'shared', 20), call('shared', 'leaf', 30)],
    );

    expect(brief(seq.calls)).toEqual(['1 a>b@1', '2 b>shared@10', '3 shared>leaf@30', '4 a>c@2', '5 c>shared@20']);
    expect(seq.calls[4].repeatOf).toBe(2);
  });

  it('marks a call back into a running step and does not follow it', () => {
    const seq = flowSequence(
      steps(['a', null], ['b', 'a']),
      [call('a', 'b', 1), call('b', 'a', 5), call('b', 'b', 6)],
    );

    expect(brief(seq.calls)).toEqual(['1 a>b@1', '2 b>a@5', '3 b>b@6']);
    expect(seq.calls.map((c) => c.back)).toEqual([false, true, true]);
    expect(seq.calls.map((c) => c.repeatOf)).toEqual([null, null, null]);
  });

  it('falls back to the one line of an edge of an older analysis, a call without a line first', () => {
    const seq = flowSequence(
      steps(['a', null], ['b', 'a'], ['c', 'a']),
      [{ from: 'a', to: 'b', line: 8, via: 'b', kind: 'call' }, { from: 'a', to: 'c', line: null, via: 'c', kind: 'call' }],
    );

    expect(brief(seq.calls)).toEqual(['1 a>c@-', '2 a>b@8']);
  });

  it('bridges around steps left out: their calls count for the step shown above', () => {
    const seq = flowSequence(
      steps(['view', null], ['api', 'view'], ['resource', 'api'], ['player', 'resource'], ['log', 'view']),
      [call('view', 'api', 3), call('view', 'log', 4), call('api', 'resource', 9, 'http'), call('resource', 'player', 20)],
      new Set(['api']),
    );

    expect(brief(seq.calls)).toEqual(['1 view>resource@-', '2 resource>player@20', '3 view>log@4']);
    expect(seq.calls.map((c) => c.bridged)).toEqual([true, false, false]);
    expect(seq.calls.map((c) => [c.depth, c.parent])).toEqual([[0, null], [1, 1], [0, null]]);
  });

  it('starts at the first steps shown when the entry point is left out', () => {
    const seq = flowSequence(
      steps(['view', null], ['api', 'view'], ['resource', 'api'], ['other', 'view']),
      [call('view', 'api', 3), call('view', 'other', 5), call('api', 'resource', 9)],
      new Set(['view']),
    );

    expect(seq.entries).toEqual([{ id: 'api', after: 0 }, { id: 'other', after: 1 }]);
    expect(brief(seq.calls)).toEqual(['1 api>resource@9']);
    expect(entryOf(seq, 1)?.id).toBe('api');
  });

  it('is empty for a flow without calls between the steps shown', () => {
    expect(flowSequence(steps(['a', null]), [])).toEqual({ entries: [{ id: 'a', after: 0 }], calls: [] });
    expect(flowSequence(steps(['a', null], ['b', 'a']), [call('a', 'b', 1)], new Set(['a', 'b']))).toEqual({ entries: [], calls: [] });
  });
});

describe('isUsedNotCalled', () => {
  it('tells constants and types from what is called', () => {
    expect(['const', 'type', 'interface', 'enum'].map(isUsedNotCalled)).toEqual([true, true, true, true]);
    expect(['method', 'function', 'component', 'class', null, undefined].map(isUsedNotCalled)).toEqual([false, false, false, false, false, false]);
  });

  it('leaves the sequence with the calls only when such steps are left out', () => {
    const seq = flowSequence(
      steps(['layout', null], ['PADDING', 'layout'], ['place', 'layout'], ['SPACING', 'place']),
      [call('layout', 'PADDING', 2), call('layout', 'place', 3), call('place', 'SPACING', 9)],
      new Set(['PADDING', 'SPACING']),
    );

    expect(brief(seq.calls)).toEqual(['1 layout>place@3']);
    expect(seq.calls[0].bridged).toBe(false);
  });
});

describe('sequenceKey', () => {
  it('is the same for the same calls computed again, and another one for other calls', () => {
    const flow = steps(['a', null], ['b', 'a'], ['c', 'b']);
    const edges = [call('a', 'b', 1), call('b', 'c', 2)];

    expect(sequenceKey(flowSequence(flow, edges))).toBe(sequenceKey(flowSequence([...flow], [...edges])));
    expect(sequenceKey(flowSequence(flow, edges, new Set(['b'])))).not.toBe(sequenceKey(flowSequence(flow, edges)));
    expect(sequenceKey(flowSequence(flow, [call('a', 'b', 1), call('b', 'c', 9)]))).not.toBe(sequenceKey(flowSequence(flow, edges)));
  });
});

describe('callStack', () => {
  it('names the calls running at a call, the outermost first', () => {
    const { calls } = flowSequence(
      steps(['a', null], ['b', 'a'], ['c', 'b'], ['d', 'a']),
      [call('a', 'b', 1), call('b', 'c', 2), call('a', 'd', 3)],
    );

    expect(callStack(calls, 2).map((c) => c.no)).toEqual([1, 2]);
    expect(callStack(calls, 3).map((c) => c.no)).toEqual([3]);
    expect(callStack(calls, 0)).toEqual([]);
    expect(callStack(calls, 9)).toEqual([]);
  });
});
