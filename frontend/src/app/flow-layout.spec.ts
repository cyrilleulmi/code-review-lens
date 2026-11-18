import { describe, expect, it } from 'vitest';
import { FRAME_PADDING, Rect, curvePath, frameAround, layoutFlow, packRows, routeMiddle, routePath } from './flow-layout';

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

describe('layoutFlow', () => {
  it('places callers left of the code they call, without overlaps, and routes every edge', async () => {
    const box = (key: string) => ({ key, w: 200, h: 46 });
    const layout = await layoutFlow({
      boxes: [box('a'), box('b'), box('c'), box('d')],
      frames: [],
      edges: [{ id: 'e0', from: 'a', to: 'b' }, { id: 'e1', from: 'b', to: 'c' }, { id: 'e2', from: 'b', to: 'd' }],
    });

    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((k) => layout.boxes.get(k)!);
    expect(a.x + a.w).toBeLessThan(b.x);
    expect(b.x + b.w).toBeLessThan(c.x);
    expect(b.x + b.w).toBeLessThan(d.x);
    expect(overlap(c, d)).toBe(false);
    expect([...layout.routes.keys()].sort()).toEqual(['e0', 'e1', 'e2']);
    // an edge starts at its caller and ends at the called box
    const route = layout.routes.get('e0')!;
    expect(route[0].x).toBeCloseTo(a.x + a.w, 0);
    expect(route[route.length - 1].x).toBeCloseTo(b.x, 0);
  });

  it('puts the methods of a class into its frame and keeps the frames apart', async () => {
    const box = (key: string, frame: string) => ({ key, w: 180, h: 32, frame });
    const layout = await layoutFlow({
      boxes: [box('a1', 'A'), box('a2', 'A'), box('b1', 'B'), box('b2', 'B'), box('b3', 'B')],
      frames: [{ key: 'A', minW: 420 }, { key: 'B' }],
      edges: [
        { id: 'e0', from: 'a1', to: 'a2' }, { id: 'e1', from: 'a2', to: 'b1' },
        { id: 'e2', from: 'b1', to: 'b2' }, { id: 'e3', from: 'b1', to: 'b3' },
      ],
    });

    const [A, B] = ['A', 'B'].map((k) => layout.frames.get(k)!);
    expect(overlap(A, B)).toBe(false);
    for (const key of ['a1', 'a2']) expect(inside(layout.boxes.get(key)!, A)).toBe(true);
    for (const key of ['b1', 'b2', 'b3']) expect(inside(layout.boxes.get(key)!, B)).toBe(true);
    // room for the head of the frame above its methods
    expect(Math.min(layout.boxes.get('a1')!.y, layout.boxes.get('a2')!.y) - A.y).toBeGreaterThanOrEqual(FRAME_PADDING.top);
    expect(A.w).toBeGreaterThanOrEqual(420);
    // within the class too the caller is left of what it calls; the route of the inner edge is in diagram coordinates
    expect(layout.boxes.get('a1')!.x + 180).toBeLessThan(layout.boxes.get('a2')!.x);
    const inner = layout.routes.get('e0')!;
    expect(inner[0].x).toBeCloseTo(layout.boxes.get('a1')!.x + 180, 0);
    expect(inner[inner.length - 1].x).toBeCloseTo(layout.boxes.get('a2')!.x, 0);
  });

  it('copes with a call back to an earlier step', async () => {
    const box = (key: string) => ({ key, w: 200, h: 46 });
    const layout = await layoutFlow({
      boxes: [box('a'), box('b')],
      frames: [],
      edges: [{ id: 'e0', from: 'a', to: 'b' }, { id: 'e1', from: 'b', to: 'a' }],
    });

    expect(layout.boxes.get('a')!.x).toBeLessThan(layout.boxes.get('b')!.x);
    expect(layout.routes.size).toBe(2);
  });
});

describe('routePath', () => {
  it('draws straight parts and rounds the corners', () => {
    expect(routePath([{ x: 0, y: 0 }, { x: 40, y: 0 }])).toBe('M 0 0 L 40 0');
    expect(routePath([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }], 5)).toBe('M 0 0 L 35 0 Q 40 0, 40 5 L 40 30');
  });

  it('shrinks the rounding on short parts', () => {
    expect(routePath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 30 }], 5)).toBe('M 0 0 L 2 0 Q 4 0, 4 2 L 4 30');
  });
});

describe('routeMiddle', () => {
  it('is halfway along the route', () => {
    expect(routeMiddle([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }])).toEqual({ x: 10, y: 10 });
  });
});

describe('curvePath', () => {
  const a = { x: 100, y: 100, w: 100, h: 40 };

  it('leaves on the side that faces the called box', () => {
    expect(curvePath(a, { x: 300, y: 200, w: 100, h: 40 }).d).toMatch(/^M 200 120 C .* 296 220$/);
    expect(curvePath(a, { x: -200, y: 100, w: 100, h: 40 }).d).toMatch(/^M 100 120 C .* -96 120$/);
  });

  it('goes down or up between boxes above each other', () => {
    expect(curvePath(a, { x: 100, y: 200, w: 100, h: 40 }).d).toMatch(/^M 160 140 C .* 160 196$/);
    expect(curvePath(a, { x: 100, y: 0, w: 100, h: 40 }).d).toMatch(/^M 160 100 C .* 160 44$/);
  });
});

describe('frameAround', () => {
  it('surrounds the boxes with the padding of a frame', () => {
    const frame = frameAround([{ x: 100, y: 100, w: 50, h: 20 }, { x: 200, y: 150, w: 50, h: 20 }]);

    expect(frame).toEqual({
      x: 100 - FRAME_PADDING.left, y: 100 - FRAME_PADDING.top,
      w: 150 + FRAME_PADDING.left + FRAME_PADDING.right, h: 70 + FRAME_PADDING.top + FRAME_PADDING.bottom,
    });
  });
});

describe('packRows', () => {
  it('fills rows from left to right and starts a new row when the width is used up', () => {
    const at = packRows([{ w: 100, h: 50 }, { w: 100, h: 80 }, { w: 100, h: 40 }, { w: 400, h: 40 }], 250, 10);

    expect(at).toEqual([{ x: 0, y: 0 }, { x: 110, y: 0 }, { x: 0, y: 90 }, { x: 0, y: 140 }]);
  });
});
