import { describe, expect, it } from 'vitest';
import { Rect, groupedTreemap, squarify } from './treemap';

const box: Rect = { x: 0, y: 0, w: 600, h: 400 };
const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.001 && b.x < a.x + a.w - 0.001 && a.y < b.y + b.h - 0.001 && b.y < a.y + a.h - 0.001;
const inside = (r: Rect, outer: Rect) => r.x >= outer.x - 0.001 && r.y >= outer.y - 0.001 && r.x + r.w <= outer.x + outer.w + 0.001 && r.y + r.h <= outer.y + outer.h + 0.001;

describe('squarify', () => {
  const values = [6, 6, 4, 3, 2, 2, 1];
  const rects = squarify(values, box);

  it('gives every value an area in proportion, filling the box', () => {
    const total = values.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => expect(area(r)).toBeCloseTo((values[i] / total) * area(box), 3));
    expect(rects.reduce((a, r) => a + area(r), 0)).toBeCloseTo(area(box), 3);
  });

  it('keeps the rectangles inside the box and apart from each other', () => {
    rects.forEach((r) => expect(inside(r, box)).toBe(true));
    rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
  });

  it('keeps the rectangles close to squares', () => {
    rects.forEach((r) => expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThan(4));
  });

  it('gives a value of zero an empty rectangle and copes with nothing to show', () => {
    const some = squarify([5, 0, 5], box);
    expect(area(some[1])).toBe(0);
    expect(area(some[0]) + area(some[2])).toBeCloseTo(area(box), 3);
    expect(squarify([], box)).toEqual([]);
    expect(squarify([0, 0], box).every((r) => area(r) === 0)).toBe(true);
    expect(squarify([1], { x: 0, y: 0, w: 0, h: 10 })[0].w).toBe(0);
  });
});

describe('groupedTreemap', () => {
  const groups = groupedTreemap([
    { id: 'a.ts', group: 'api', value: 30 }, { id: 'b.ts', group: 'api', value: 10 }, { id: 'c.ts', group: 'logic', value: 60 },
    { id: 'd.ts', group: '', value: 5 }, { id: 'empty.ts', group: 'logic', value: 0 },
  ], box);

  it('has a frame per group, the largest first, with its items inside below the head', () => {
    expect(groups.map((g) => [g.id, g.value])).toEqual([['logic', 60], ['api', 40], ['', 5]]);
    expect(groups[1].items.map((i) => i.id)).toEqual(['a.ts', 'b.ts']);
    for (const g of groups) {
      for (const item of g.items) {
        expect(inside(item.rect, g.rect)).toBe(true);
        expect(item.rect.y).toBeGreaterThanOrEqual(g.rect.y + 18 - 0.001);
      }
    }
  });

  it('leaves out items without a value', () => {
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain('empty.ts');
  });
});
