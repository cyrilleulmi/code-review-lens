import { describe, expect, it } from 'vitest';
import { acceptLevel, everywhereTargets, lineBoxes } from './accept-boxes';
import { Acceptance, NOT_ACCEPTED, accept } from './acceptance';

const FLOW = 'flows/flow-1';
const THREE = ['quick-wins/mapper', FLOW, 'security/a-ts'];

/** Applies the marks of a click on "everywhere" like the store and the backend do: one after the other. */
function everywhere(a: Acceptance, places: string[], place: string | null, ok: boolean): Acceptance {
  return everywhereTargets(places, place, ok).reduce((state, target) => accept(state, places, target, ok), a);
}

describe('accept boxes', () => {
  it('shows one box per place, the place shown in front', () => {
    const boxes = lineBoxes(NOT_ACCEPTED, THREE, FLOW);
    expect(boxes.front).toEqual({ on: false });
    expect(boxes.rest).toEqual([{ id: 'quick-wins/mapper', on: false }, { id: 'security/a-ts', on: false }]);
    expect(boxes.all).toBe(false);
  });

  it('ticks only the front box when the line is accepted here', () => {
    const boxes = lineBoxes(accept(NOT_ACCEPTED, THREE, FLOW, true), THREE, FLOW);
    expect(boxes.front).toEqual({ on: true });
    expect(boxes.rest.map((b) => b.on)).toEqual([false, false]);
    expect(boxes.all).toBe(false);
  });

  it('shows an accept at another place in the box of that place', () => {
    const boxes = lineBoxes(accept(NOT_ACCEPTED, THREE, 'security/a-ts', true), THREE, FLOW);
    expect(boxes.front).toEqual({ on: false });
    expect(boxes.rest.map((b) => b.on)).toEqual([false, true]);
    expect(boxes.completes).toBe(false);
  });

  it('accepts everywhere with a click on the other boxes, whether or not the line is accepted here', () => {
    expect(lineBoxes(everywhere(NOT_ACCEPTED, THREE, FLOW, true), THREE, FLOW)).toMatchObject({ front: { on: true }, all: true });
    const elsewhere = accept(NOT_ACCEPTED, THREE, 'security/a-ts', true);
    expect(lineBoxes(everywhere(elsewhere, THREE, FLOW, true), THREE, FLOW).all).toBe(true);
  });

  it('knows when the front box is the last one missing', () => {
    const others = accept(accept(NOT_ACCEPTED, THREE, 'security/a-ts', true), THREE, 'quick-wins/mapper', true);
    expect(lineBoxes(others, THREE, FLOW).completes).toBe(true);
  });

  it('takes the other places back with a second click on the other boxes and keeps this one', () => {
    const here = accept(NOT_ACCEPTED, THREE, FLOW, true);
    const all = everywhere(here, THREE, FLOW, true);
    expect(lineBoxes(all, THREE, FLOW)).toMatchObject({ front: { on: true }, all: true });
    const back = everywhere(all, THREE, FLOW, false);
    expect(lineBoxes(back, THREE, FLOW)).toMatchObject({ front: { on: true }, all: false });
    expect(lineBoxes(back, THREE, FLOW).rest.map((b) => b.on)).toEqual([false, false]);
  });

  it('has no front box in a view without a place: all boxes mean everywhere', () => {
    const boxes = lineBoxes(accept(NOT_ACCEPTED, THREE, FLOW, true), THREE, null);
    expect(boxes.front).toBeNull();
    expect(boxes.rest.map((b) => b.on)).toEqual([false, true, false]);
    expect(everywhere(NOT_ACCEPTED, THREE, null, true).full).toBe(true);
    expect(everywhere(everywhere(NOT_ACCEPTED, THREE, null, true), THREE, null, false)).toBe(NOT_ACCEPTED);
  });

  it('accepts a line with a single place everywhere right away', () => {
    const one = [FLOW];
    expect(lineBoxes(NOT_ACCEPTED, one, FLOW)).toEqual({ front: { on: false }, rest: [], all: false, completes: true });
    expect(lineBoxes(accept(NOT_ACCEPTED, one, FLOW, true), one, FLOW).all).toBe(true);
    expect(lineBoxes(accept(NOT_ACCEPTED, [], null, true), [], null).all).toBe(true);
  });

  it('tells accepted here (green) from accepted everywhere (blue)', () => {
    expect(acceptLevel({ ok: 2, total: 3, all: 2 })).toBe('open');
    expect(acceptLevel({ ok: 3, total: 3, all: 2 })).toBe('here');
    expect(acceptLevel({ ok: 3, total: 3, all: 3 })).toBe('all');
    expect(acceptLevel({ ok: 0, total: 0, all: 0 })).toBe('open');
  });
});
