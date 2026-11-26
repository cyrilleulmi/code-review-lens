import { describe, expect, it } from 'vitest';
import { SequenceEdge, flowSequence } from './flow-sequence';
import { SEQUENCE_HEAD, SEQUENCE_ROW, labelWidth, sequenceLayout } from './sequence-layout';

const steps = (...list: [string, string | null][]) => list.map(([segmentId, parentSegmentId]) => ({ segmentId, parentSegmentId }));
const call = (from: string, to: string, lines: number | number[]): SequenceEdge => {
  const all = Array.isArray(lines) ? lines : [lines];
  return { from, to, line: all[0], via: to, kind: 'call', lines: all };
};
/** "View.save" belongs to the class View and is labelled "save". */
const byPrefix = (id: string) => ({ key: id.split('.')[0], name: id.split('.')[0], area: null });
const method = (id: string) => id.split('.')[1];

/** view.save -> api.set -> resource.update -> resource.validate -> player.isTaken, then view.save -> view.done */
const sequence = flowSequence(
  steps(['View.save', null], ['Api.set', 'View.save'], ['Resource.update', 'Api.set'], ['Resource.validate', 'Resource.update'],
    ['Player.isTaken', 'Resource.validate'], ['View.done', 'View.save']),
  [call('View.save', 'Api.set', 3), call('Api.set', 'Resource.update', 9), call('Resource.update', 'Resource.validate', 20),
    call('Resource.validate', 'Player.isTaken', 31), call('View.save', 'View.done', 5)],
);
const layout = sequenceLayout(sequence, byPrefix, method);

describe('sequenceLayout', () => {
  it('gives every class one lifeline, in the order the classes come up, from left to right', () => {
    expect(layout.lifelines.map((l) => l.key)).toEqual(['View', 'Api', 'Resource', 'Player']);
    const xs = layout.lifelines.map((l) => l.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    // the heads do not touch
    layout.lifelines.slice(1).forEach((l, i) => expect(l.x - l.w / 2).toBeGreaterThan(layout.lifelines[i].x + layout.lifelines[i].w / 2));
  });

  it('has a row for the entry point and one per call, from top to bottom', () => {
    expect(layout.messages.map((m) => [m.call?.no ?? 0, m.label])).toEqual([
      [0, 'save'], [1, 'set'], [2, 'update'], [3, 'validate'], [4, 'isTaken'], [5, 'done'],
    ]);
    expect(layout.messages.map((m) => m.y)).toEqual(layout.messages.map((_, i) => SEQUENCE_HEAD + i * SEQUENCE_ROW + SEQUENCE_ROW / 2));
    expect(layout.height).toBeGreaterThan(layout.messages[5].y + SEQUENCE_ROW / 2);
  });

  it('draws a call from the lifeline of the caller to that of the class called', () => {
    const x = Object.fromEntries(layout.lifelines.map((l) => [l.key, l.x]));
    const set = layout.messages[1];
    expect(set.self).toBe(false);
    expect(set.x1).toBeGreaterThan(x['View']);
    expect(set.x2).toBeLessThan(x['Api']);
    expect(Math.abs(set.x1 - x['View'])).toBeLessThan(12);
    expect(Math.abs(set.x2 - x['Api'])).toBeLessThan(12);
  });

  it('leaves room for every label between the lifelines it connects', () => {
    for (const m of layout.messages.filter((m) => m.call && !m.self)) {
      expect(Math.abs(m.x2 - m.x1)).toBeGreaterThanOrEqual(labelWidth(m.label));
      expect(m.lx).toBeGreaterThanOrEqual(Math.min(m.x1, m.x2));
      expect(m.lx + labelWidth(m.label)).toBeLessThanOrEqual(Math.max(m.x1, m.x2));
    }
    // the entry point: its label stands left of its lifeline, inside the diagram
    expect(layout.messages[0].x1).toBeGreaterThanOrEqual(0);
    expect(layout.messages[0].lx + labelWidth('save')).toBeLessThanOrEqual(layout.messages[0].x2);
  });

  it('draws a call within a class as a loop with its label to the right, inside the diagram', () => {
    const validate = layout.messages[3];
    const done = layout.messages[5];
    expect(validate.self).toBe(true);
    expect(validate.lx).toBeGreaterThan(validate.x1);
    // the loop of the last lifeline but one does not run into the next lifeline
    const player = layout.lifelines[3];
    expect(validate.lx + labelWidth('validate')).toBeLessThan(player.x);
    expect(done.self).toBe(true);
    expect(done.lx + labelWidth('done')).toBeLessThanOrEqual(layout.width);
  });

  it('shows how long a step runs: a bar from its call to the last call made from it', () => {
    const bar = (no: number) => layout.activations.find((a) => a.no === no)!;
    const y = (no: number) => layout.messages.find((m) => (m.call?.no ?? 0) === no)!.y;
    // the entry point runs to the end
    expect(bar(0).key).toBe('View');
    expect(bar(0).y2).toBeGreaterThan(y(5));
    // update runs while validate and isTaken are called
    expect(bar(2).key).toBe('Resource');
    expect(bar(2).y1).toBeLessThan(y(3));
    expect(bar(2).y2).toBeGreaterThan(y(4));
    expect(bar(2).y2).toBeLessThan(y(5));
    // isTaken calls nothing: a short bar in its own row
    expect(bar(4).y2 - bar(4).y1).toBeLessThan(SEQUENCE_ROW);
  });

  it('sets a step of a class that is already running to the right of the running bar', () => {
    const bar = (no: number) => layout.activations.find((a) => a.no === no)!;
    expect(bar(3).key).toBe('Resource');
    expect(bar(3).x).toBeGreaterThan(bar(2).x);
    expect(bar(5).x).toBeGreaterThan(bar(0).x);
    // a nested bar ends before the bar around it
    expect(bar(3).y2).toBeLessThan(bar(2).y2);
  });

  it('starts a new row and a new bar for every entry point', () => {
    const two = flowSequence(steps(['A.one', null], ['B.x', 'A.one'], ['C.two', null], ['B.y', 'C.two']), [call('A.one', 'B.x', 1), call('C.two', 'B.y', 1)]);
    const l = sequenceLayout(two, byPrefix, method);

    expect(l.messages.map((m) => [m.call?.no ?? 0, m.label])).toEqual([[0, 'one'], [1, 'x'], [0, 'two'], [2, 'y']]);
    expect(l.lifelines.map((x) => x.key)).toEqual(['A', 'B', 'C']);
    const entries = l.activations.filter((a) => a.no === 0);
    expect(entries.map((a) => a.key)).toEqual(['A', 'C']);
    expect(entries[0].y2).toBeLessThan(entries[1].y1);
  });

  it('is empty for an empty sequence', () => {
    expect(sequenceLayout({ entries: [], calls: [] }, byPrefix, method)).toMatchObject({ lifelines: [], messages: [], activations: [] });
  });
});
