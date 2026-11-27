/**
 * Layout of the flow diagram. The boxes (steps or classes, in the combined view steps inside the frame of their class)
 * are placed by ELK (Eclipse Layout Kernel, elkjs): layers from left to right in call direction, few crossings, edges
 * at right angles around the boxes. ELK is loaded on demand (its own chunk), so it does not weigh on the start of the app.
 * Boxes the user moved by hand keep their place; their connections are then drawn as simple curves (curvePath).
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

/** A box to place; frame = key of the frame (class) it sits in. Keys of boxes and frames must not collide. */
export interface LayoutBox {
  key: string;
  w: number;
  h: number;
  frame?: string | null;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** room for a text at the edge (what the call gives back): the engine keeps it free and says where it is */
  label?: { w: number; h: number } | null;
}

export interface LayoutInput {
  boxes: readonly LayoutBox[];
  /** the frames in the order they should appear from the top; minW: room for the head (name of the class) */
  frames: readonly { key: string; minW?: number }[];
  edges: readonly LayoutEdge[];
}

export interface Layout {
  boxes: Map<string, Rect>;
  frames: Map<string, Rect>;
  /** per edge id the points of its route: start, bends, end */
  routes: Map<string, Point[]>;
  /** per edge id with a label the place the engine kept free for it (top left corner) */
  labels: Map<string, Rect>;
}

/** Room inside a frame: the head with the name of the class on top, air around the boxes. */
export const FRAME_PADDING = { top: 44, left: 18, bottom: 18, right: 18 };

const SPACING: Record<string, string> = {
  // between the columns: room for the vertical parts of the edges
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.spacing.edgeNodeBetweenLayers': '22',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  // within a column
  'elk.spacing.nodeNode': '26',
  'elk.spacing.edgeNode': '20',
  'elk.spacing.edgeEdge': '12',
};

const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  // one layout over classes and their methods: a method sits in the column its callers put it in, also inside a frame
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  // keep the call order from top to bottom where it costs no crossing; a call back to an earlier step runs backwards
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  // the text of an edge always on the same side: below its line
  'elk.layered.edgeLabels.sideSelection': 'ALWAYS_DOWN',
  ...SPACING,
};

interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
}

interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  container?: string;
  labels?: { id?: string; text?: string; x?: number; y?: number; width?: number; height?: number; layoutOptions?: Record<string, string> }[];
  sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[];
}

interface ElkGraph extends ElkNode {
  edges: ElkEdge[];
}

interface Elk {
  layout(graph: ElkGraph): Promise<ElkGraph>;
}

let elk: Promise<Elk> | null = null;

/** The layout engine, loaded once (lazily: about 1.6 MB of script in its own chunk). */
function engine(): Promise<Elk> {
  elk ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default() as unknown as Elk);
  return elk;
}

/** Places boxes and frames and routes the edges. Rejects when the engine cannot be loaded or fails. */
export async function layoutFlow(input: LayoutInput): Promise<Layout> {
  const { top, left, bottom, right } = FRAME_PADDING;
  const leaf = (b: LayoutBox): ElkNode => ({ id: b.key, width: b.w, height: b.h });
  const frames = new Set(input.frames.map((f) => f.key));
  const children: ElkNode[] = [
    ...input.frames.map((f) => ({
      id: f.key,
      layoutOptions: {
        'elk.padding': `[top=${top},left=${left},bottom=${bottom},right=${right}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${Math.round(f.minW ?? 0)},0)`,
        ...SPACING,
      },
      children: input.boxes.filter((b) => b.frame === f.key).map(leaf),
    })),
    ...input.boxes.filter((b) => !b.frame || !frames.has(b.frame)).map(leaf),
  ];
  const known = new Set(input.boxes.map((b) => b.key));
  const graph: ElkGraph = {
    id: 'root',
    layoutOptions: ROOT_OPTIONS,
    children,
    edges: input.edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to)
      .map((e) => ({
        id: e.id, sources: [e.from], targets: [e.to],
        ...(e.label ? { labels: [{ id: e.id + '-label', text: ' ', width: e.label.w, height: e.label.h, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] } : {}),
      })),
  };
  const done = await (await engine()).layout(graph);

  const result: Layout = { boxes: new Map(), frames: new Map(), routes: new Map(), labels: new Map() };
  const rect = (n: ElkNode, dx = 0, dy = 0): Rect => ({ x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy, w: n.width ?? 0, h: n.height ?? 0 });
  for (const node of done.children ?? []) {
    if (frames.has(node.id)) {
      const frame = rect(node);
      result.frames.set(node.id, frame);
      (node.children ?? []).forEach((c) => result.boxes.set(c.id, rect(c, frame.x, frame.y)));
    } else {
      result.boxes.set(node.id, rect(node));
    }
  }
  for (const edge of done.edges) {
    // the points of an edge are relative to its container: the frame when both ends are in it, else the diagram
    const origin = edge.container ? result.frames.get(edge.container) : undefined;
    const move = (p: Point): Point => ({ x: p.x + (origin?.x ?? 0), y: p.y + (origin?.y ?? 0) });
    const points = (edge.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]).map(move);
    if (points.length >= 2) {
      result.routes.set(edge.id, points);
    }
    const label = edge.labels?.[0];
    if (label?.x != null && label.y != null) {
      result.labels.set(edge.id, { ...move({ x: label.x, y: label.y }), w: label.width ?? 0, h: label.height ?? 0 });
    }
  }
  return result;
}

/** SVG path along the points of a route, with the corners rounded off. */
export function routePath(points: readonly Point[], radius = 7): string {
  if (points.length < 2) {
    return '';
  }
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M ${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, dist(a, p) / 2, dist(p, b) / 2);
    const before = toward(p, a, r);
    const after = toward(p, b, r);
    d += ` L ${f(before.x)} ${f(before.y)} Q ${f(p.x)} ${f(p.y)}, ${f(after.x)} ${f(after.y)}`;
  }
  const end = points[points.length - 1];
  return `${d} L ${f(end.x)} ${f(end.y)}`;
}

/** The point halfway along a route (for the label of an edge). */
export function routeMiddle(points: readonly Point[]): Point {
  const total = points.slice(1).reduce((sum, p, i) => sum + dist(points[i], p), 0);
  let rest = total / 2;
  for (let i = 1; i < points.length; i++) {
    const len = dist(points[i - 1], points[i]);
    if (rest <= len && len > 0) {
      return toward(points[i - 1], points[i], rest);
    }
    rest -= len;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

/**
 * A simple connection between two boxes wherever they are (boxes moved by hand, and before the layout engine has
 * answered): a curve from the side of the caller that faces the called box - right to left when it lies to the right,
 * left to right when it lies to the left, bottom to top / top to bottom when one is above the other.
 */
export function curvePath(a: Rect, b: Rect): { d: string; middle: Point } {
  const gap = 12;
  let from: Point;
  let to: Point;
  let horizontal = true;
  if (b.x >= a.x + a.w + gap) {
    from = { x: a.x + a.w, y: a.y + a.h / 2 };
    to = { x: b.x - 4, y: b.y + b.h / 2 };
  } else if (b.x + b.w + gap <= a.x) {
    from = { x: a.x, y: a.y + a.h / 2 };
    to = { x: b.x + b.w + 4, y: b.y + b.h / 2 };
  } else {
    horizontal = false;
    const down = b.y + b.h / 2 >= a.y + a.h / 2;
    // side by side on the centre line would hide the line behind the boxes: leave and arrive a little to the right
    const x1 = a.x + a.w * 0.6;
    const x2 = b.x + b.w * 0.6;
    from = { x: x1, y: down ? a.y + a.h : a.y };
    to = { x: x2, y: down ? b.y - 4 : b.y + b.h + 4 };
  }
  const reach = Math.max(24, (horizontal ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y)) / 2);
  const dir = horizontal ? Math.sign(to.x - from.x) || 1 : Math.sign(to.y - from.y) || 1;
  const c1 = horizontal ? { x: from.x + reach * dir, y: from.y } : { x: from.x, y: from.y + reach * dir };
  const c2 = horizontal ? { x: to.x - reach * dir, y: to.y } : { x: to.x, y: to.y - reach * dir };
  const f = (n: number) => Math.round(n * 10) / 10;
  return {
    d: `M ${f(from.x)} ${f(from.y)} C ${f(c1.x)} ${f(c1.y)}, ${f(c2.x)} ${f(c2.y)}, ${f(to.x)} ${f(to.y)}`,
    middle: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
  };
}

/** The frame around boxes: their bounding box plus the padding of a frame. */
export function frameAround(boxes: readonly Rect[]): Rect {
  const x = Math.min(...boxes.map((b) => b.x)) - FRAME_PADDING.left;
  const y = Math.min(...boxes.map((b) => b.y)) - FRAME_PADDING.top;
  return {
    x, y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) + FRAME_PADDING.right - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) + FRAME_PADDING.bottom - y,
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The point at distance d from a towards b. */
function toward(a: Point, b: Point, d: number): Point {
  const len = dist(a, b) || 1;
  return { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len };
}

/**
 * Packs rectangles from left to right into rows no wider than maxWidth (a rectangle wider than that gets a row of
 * its own), with `gap` between them: for the parts of a diagram that have no connection and so no place in the
 * layered layout. Returns the top left corner of each, in the order given.
 */
export function packRows(sizes: readonly { w: number; h: number }[], maxWidth: number, gap: number): Point[] {
  const result: Point[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const size of sizes) {
    if (x > 0 && x + size.w > maxWidth) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    result.push({ x, y });
    x += size.w + gap;
    rowHeight = Math.max(rowHeight, size.h);
  }
  return result;
}

/**
 * Left edge of each column of a staircase by call depth, every column as wide as its widest item, with `gap` between
 * the columns: boxes as wide as their names never overlap the next column. Index = depth; a depth without items
 * takes no room.
 */
export function columnStarts(items: readonly { depth: number; w: number }[], gap: number): number[] {
  const deepest = Math.max(-1, ...items.map((i) => i.depth));
  const widths = Array.from({ length: deepest + 1 }, (_, d) => Math.max(0, ...items.filter((i) => i.depth === d).map((i) => i.w)));
  const starts: number[] = [];
  let x = 0;
  widths.forEach((w) => {
    starts.push(x);
    x += w > 0 ? w + gap : 0;
  });
  return starts;
}
