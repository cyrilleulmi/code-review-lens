/**
 * Squarified treemap (Bruls, Huizing, van Wijk): rectangles whose areas are proportional to their values and that are
 * as close to squares as the box allows. For the "Änderungs-Karte": files by changed lines, grouped by layer.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** The worst aspect ratio of a row of areas laid along a side of this length (1 = all squares). */
function worst(row: readonly number[], side: number): number {
  const s = sum(row);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

/**
 * Places `values` (largest first works best) in `box`; the result has a rectangle per value, in the same order.
 * Values of 0 or less get an empty rectangle.
 */
export function squarify(values: readonly number[], box: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const shown = values.map((value, i) => ({ value, i })).filter((v) => v.value > 0);
  const total = sum(shown.map((v) => v.value));
  if (!total || box.w <= 0 || box.h <= 0) {
    return out;
  }
  const scale = (box.w * box.h) / total;
  const areas = shown.map((v) => v.value * scale);
  let { x, y, w, h } = box;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    // a row grows while its worst aspect ratio gets better
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) {
      row.push(areas[j++]);
    }
    const thick = sum(row) / side;
    let offset = 0;
    row.forEach((area, k) => {
      const length = area / thick;
      // the row lies along the shorter side: a column at the left of a wide box, a row at the top of a high one
      out[shown[i + k].i] = w >= h ? { x, y: y + offset, w: thick, h: length } : { x: x + offset, y, w: length, h: thick };
      offset += length;
    });
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    i = j;
  }
  return out;
}

export interface MapItem {
  id: string;
  group: string;
  value: number;
}

export interface MapGroup {
  id: string;
  value: number;
  /** the frame of the group; its items lie below the head */
  rect: Rect;
  items: { id: string; value: number; rect: Rect }[];
}

/**
 * A treemap in two levels: the groups in `box`, the items of each group inside it below a head of `head` px (the
 * name of the group), `gap` px apart from the frame. Groups and items largest first.
 */
export function groupedTreemap(items: readonly MapItem[], box: Rect, head = 18, gap = 3): MapGroup[] {
  const byGroup = new Map<string, MapItem[]>();
  for (const item of items) {
    if (item.value > 0) {
      byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
    }
  }
  const groups = [...byGroup]
    .map(([id, list]) => ({ id, list: [...list].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)), value: sum(list.map((i) => i.value)) }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const frames = squarify(groups.map((g) => g.value), box);
  return groups.map((g, n) => {
    const rect = frames[n];
    const inner = { x: rect.x + gap, y: rect.y + head, w: Math.max(0, rect.w - 2 * gap), h: Math.max(0, rect.h - head - gap) };
    const rects = squarify(g.list.map((i) => i.value), inner);
    return { id: g.id, value: g.value, rect, items: g.list.map((item, k) => ({ id: item.id, value: item.value, rect: rects[k] })) };
  });
}
