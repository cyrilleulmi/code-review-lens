import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { EdgeRunStatus, Flow, FlowEdge, FlowStep, Segment, StepRunStatus } from './api';
import { NgTemplateOutlet } from '@angular/common';
import { CodeBlock, flashLine } from './code-block';
import { FlowCodeLevel, FlowDiagramLevel, InlineStep, classLinks, codeLevelFor, inlineTree, classOf, classRuns, groupByClass, inFileOrder, intersect, weakest } from './flow-classes';
import { outsideBranch, sameSet, withoutAreas } from './flow-focus';
import { FRAME_PADDING, Layout, Point, curvePath, frameAround, layoutFlow, routeMiddle, routePath } from './flow-layout';
import { Icon, SymbolBadge } from './icon';
import { EDGE_COLORS, areaColor, areaLabel, areaOfSegment, edgeColor, edgeColorIndex } from './look';
import { EDGE_LABELS, STEP_LABELS, edgeTitle, flowRuns, stepTitle } from './mock-boundaries';
import { BOTH_SIDES_LABEL, bothSides, contractLines } from './http-tests';
import { ReviewStore } from './review.store';
import { serverText, t } from './i18n';
import { diffSides } from './split-diff';

interface Node {
  step: FlowStep;
  segment: Segment;
  /** step number in the whole flow */
  no: number;
  /** call depth in the flow, less the steps of removed areas above it */
  depth: number;
  /** layer of the step ('' = none) */
  area: string;
  /** the caller shown: the parent, or the nearest ancestor left when areas in between are removed; null = a root */
  caller: string | null;
  /** labels of the removed areas between caller and step (empty = direct call) */
  bridged: string[];
}

/**
 * A box of the diagram: one step (method level), a class with its steps of the flow (class level), or - combined -
 * a class as a frame and its steps as smaller boxes inside it.
 */
interface Box {
  /** segment id of the step, or the key of the class */
  key: string;
  /** segment ids of its steps, in call order */
  ids: string[];
  /** number of its (first) step */
  no: number;
  name: string;
  /** symbol kind for the badge */
  kind: string | null;
  /** second line: where the step is, or the methods of the class */
  hint: string;
  area: string | null;
  quick: boolean;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** a step inside the frame of its class (combined level): one line, smaller */
  mini: boolean;
  /** key of that frame; null for boxes without one */
  frame: string | null;
}

/** A connection of the diagram between two boxes (keys), with the steps at its ends for the highlighting. */
interface Link {
  from: string;
  to: string;
  ends: string[];
  /** colour index 1..8 */
  c: number;
  http: boolean;
  run: EdgeRunStatus | null;
  both: boolean;
  /** around removed areas */
  bridged: boolean;
  title: string;
}

/** What "Einzeln durchgehen" shows at a time: a step, or a class with all its steps. */
interface Unit {
  key: string;
  /** a whole class */
  framed: boolean;
  ids: string[];
}

/**
 * A card of the code. Class level: a class in a frame with all its steps of the flow in file order. Method level: a
 * run of consecutive steps of one class in call order, held together by a bracket with the name of the class.
 */
interface Card {
  key: string;
  /** class level: frame with progress and "Klasse ok" */
  framed: boolean;
  classKey: string;
  name: string;
  /** file names of the class */
  files: string;
  area: string | null;
  depth: number;
  /** the steps as they are laid out in the card; indent = call levels below the card's depth (method level) */
  members: { node: Node; indent: number }[];
  /** their segment ids */
  ids: string[];
  /** method level: the steps of the same class in other runs of the flow */
  others: { id: string; no: number; name: string }[];
  /** a block of the card is shown side by side: the card needs more width */
  wide: boolean;
}

interface Connector {
  d: string;
  from: string;
  to: string;
  /** colour index 1..8 of the connection */
  c: number;
  http: boolean;
}

const NODE_W = 236;
const NODE_H = 46;
/** Combined level of the diagram: the smaller boxes of the steps inside the frame of their class. */
const MINI_H = 32;
const MINI_GAP = 14;
/** Width of a character of the code font in the diagram (12px), to size boxes and frames by their names. */
const CHAR_W = 7.3;
const COL_GAP = 56;
const ROW_GAP = 12;
/** Indentation of the code blocks per call level (the cards scroll horizontally when it gets deep). */
const INDENT = 56;
/** Side by side the blocks need the width for their two halves: the call levels are only hinted at. */
const SPLIT_INDENT = 14;
/** Horizontal distance between two connector lanes in the left margin. */
const LANE = 11;
const MIN_GUTTER = 32;
/** From weakest to strongest: a class / a connection between classes shows the weakest status of its parts. */
const STEP_RUNS: StepRunStatus[] = ['none', 'mocked', 'tested'];
const EDGE_RUNS: EdgeRunStatus[] = ['none', 'partial', 'separate', 'tested'];

/**
 * A data flow: a call-tree diagram on top, below the code of each step in call order. Call sites inside
 * the code are connected to the step they call with lines in the left margin. Steps can be hidden (one by one,
 * or all outside one branch), finished steps hidden, or the steps walked through one by one.
 *
 * Diagram and code each have a level: methods (one box / card per step) or classes (the steps of a class combined).
 * The code follows the level of the diagram unless it is given its own.
 */
@Component({
  selector: 'app-flow-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeBlock, Icon, NgTemplateOutlet, SymbolBadge],
  templateUrl: './flow-view.html',
  styleUrl: './flow-view.scss',
})
export class FlowView {
  protected readonly store = inject(ReviewStore);
  readonly flow = input.required<Flow>();

  private readonly cards = viewChild.required<ElementRef<HTMLElement>>('cards');
  protected readonly connectors = signal<Connector[]>([]);
  protected readonly railHeight = signal(0);
  protected readonly railWidth = signal(0);
  /** Left margin of the code blocks: room for one lane per (overlapping) connection. */
  protected readonly gutter = signal(MIN_GUTTER);
  protected readonly markers = Array.from({ length: EDGE_COLORS }, (_, i) => i + 1);
  protected readonly areaColor = areaColor;
  protected readonly areaLabel = areaLabel;

  /** Every connection of the flow keeps one colour: "from>to" -> CSS colour. */
  protected readonly edgeColors = computed(() => {
    const map: Record<string, string> = {};
    this.flow().edges.forEach((e, i) => (map[e.from + '>' + e.to] = edgeColor(i)));
    return map;
  });
  /** The steps under the pointer (a step, or all steps of a class): their connections are emphasised. */
  protected readonly hovered = signal<ReadonlySet<string> | null>(null);
  /** Class whose name is under the pointer in the code (method level): all its runs light up. */
  protected readonly hoveredClass = signal<string | null>(null);
  /** Side by side (old | new) and a step has both sides: the blocks are less indented, see SPLIT_INDENT. */
  protected readonly split = computed(() => this.store.diffMode() === 'split' && this.nodes().some((n) => splits(n.segment)));
  protected readonly indent = computed(() => (this.split() ? SPLIT_INDENT : INDENT));

  /** What the user set on the page of this flow: levels and removed areas hold for this flow only (ReviewStore.flowPage). */
  private readonly page = computed(() => this.store.flowPage(this.flow().id));
  /** Level of the diagram: methods, classes, or - the default - classes as frames with their methods inside. */
  protected readonly level = computed(() => this.page().level);
  /** Level of the code: its own (methods, classes, or by line), else the one that goes with the diagram. */
  protected readonly codeLevel = computed<FlowCodeLevel>(() => this.page().code ?? codeLevelFor(this.level()));
  /** The code has no level of its own: it follows the diagram. */
  protected readonly codeFollows = computed(() => this.page().code == null);
  /** Areas taken out of this flow. */
  private readonly hiddenAreas = computed(() => this.page().hiddenAreas);

  /** Mock-Grenzen: what the tests really execute, per step (segment id) and per edge ("from>to"). */
  /** What the tests run in this flow; nothing while the test enrichments are switched off. */
  protected readonly runs = computed(() => flowRuns(this.store.testInfo() ? this.store.flowCoverage().get(this.flow().id) : undefined));
  protected readonly hasRuns = computed(() => this.runs().steps.size > 0);
  /** A REST edge of this flow is checked from both sides (HTTP-Tests): the legend explains the label. */
  protected readonly hasBothSides = computed(() => [...this.runs().edges.values()].some(bothSides));
  protected readonly t = t;
  protected readonly serverText = serverText;
  protected readonly bothSidesLabel = BOTH_SIDES_LABEL;
  protected readonly stepLabels = STEP_LABELS;
  protected readonly edgeLabels = EDGE_LABELS;
  protected readonly runLegend: StepRunStatus[] = ['tested', 'mocked', 'none'];

  /** The flow's place: each step needs an ok here (a step can be part of several flows). */
  protected readonly place = computed(() => 'flows/' + this.flow().id);
  /** Steps hidden by the user (eye / focus). Reset when another flow is shown. */
  protected readonly hidden = linkedSignal<string, ReadonlySet<string>>({ source: () => this.flow().id, computation: () => new Set() });
  /** Step-by-step mode: index of the only card shown (units()), null = off. Reset with the flow and the level of the code. */
  protected readonly stepIndex = linkedSignal<string, number | null>({ source: () => this.flow().id + '|' + this.codeLevel(), computation: () => null });
  protected readonly hideDone = signal(false);
  /** Box whose focus button was used last; it shows as focused while the hidden steps are still exactly the rest. */
  private readonly lastFocus = linkedSignal<string, { key: string; ids: string[] } | null>({ source: () => this.flow().id, computation: () => null });
  protected readonly focused = computed(() => {
    const last = this.lastFocus();
    return last && sameSet(this.hidden(), this.outside(last.ids)) ? last.key : null;
  });

  /** Every step of the flow with its segment and area, in flow order (also those of removed areas). */
  private readonly allSteps = computed(() => {
    const segs = this.store.segments();
    return this.flow().steps
      .map((step, i) => ({ step, no: i + 1 }))
      .filter(({ step }) => segs.has(step.segmentId))
      .map(({ step, no }) => {
        const segment = segs.get(step.segmentId)!;
        return { step, no, segment, area: this.areaOf(segment) ?? '' };
      });
  });

  /** The areas of the flow in call order with their number of steps; the bar shows them from two on. */
  protected readonly areas = computed(() => {
    const removed = this.hiddenAreas();
    const counts = new Map<string, number>();
    for (const s of this.allSteps()) {
      counts.set(s.area, (counts.get(s.area) ?? 0) + 1);
    }
    return [...counts].map(([id, count]) => ({
      id, count, label: id ? areaLabel(id) : t('ohne Schicht'), color: areaColor(id || null), removed: removed.has(id),
    }));
  });

  /** At least one area of this flow is removed. */
  protected readonly areasRemoved = computed(() => this.areas().some((a) => a.removed));

  /** The steps shown in diagram and code: all but those of removed areas, bridged and moved up to fill the gaps. */
  protected readonly nodes = computed<Node[]>(() => {
    return withoutAreas(this.allSteps(), this.hiddenAreas()).map((s) => ({
      ...s,
      bridged: s.skipped.map((area) => (area ? areaLabel(area) : t('ohne Schicht'))),
    }));
  });

  /** The steps combined by class, in the order the classes are first reached. */
  private readonly classes = computed(() => {
    const segs = this.store.segments();
    const components = this.store.componentBySegment();
    return groupByClass(this.nodes(), (id) => classOf(segs.get(id)!, components.get(id)));
  });

  /**
   * The diagram at its level, before the layout engine has placed it. boxes: what the connections run between - a
   * step each, or a class each; combined, the steps as smaller boxes inside the frame of their class. The places
   * here are a simple staircase by call depth: shown until the layout arrives, and kept if it cannot be loaded.
   */
  private readonly sketch = computed<{ frames: Box[]; boxes: Box[] }>(() => {
    const at = (depth: number, row: number) => ({
      depth, x: depth * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H, mini: false, frame: null,
    });
    const step = (n: Node) => ({
      key: n.step.segmentId, ids: [n.step.segmentId], no: n.no, name: this.nodeName(n.segment), kind: n.segment.symbolKind,
      hint: this.nodeHint(n.segment), area: this.areaOf(n.segment), quick: n.segment.category === 'quick-wins',
    });
    const cls = (g: { key: string; name: string; members: Node[] }) => ({
      key: g.key, ids: g.members.map((m) => m.step.segmentId), no: g.members[0].no, name: g.name, kind: 'class',
      hint: g.members.map((m) => this.nodeName(m.segment)).join(', '), area: this.areaOf(g.members[0].segment),
      quick: g.members.every((m) => m.segment.category === 'quick-wins'),
    });
    const level = this.level();
    if (level === 'method') {
      return { frames: [], boxes: this.nodes().map((n, row) => ({ ...step(n), ...at(n.depth, row) })) };
    }
    if (level === 'class') {
      return { frames: [], boxes: this.classes().map((g, row) => ({ ...cls(g), ...at(g.depth, row) })) };
    }
    const frames: Box[] = [];
    const boxes: Box[] = [];
    const column = 280 + FRAME_PADDING.left + FRAME_PADDING.right + COL_GAP;
    let y = 0;
    for (const g of this.classes()) {
      const x = g.depth * column;
      const h = FRAME_PADDING.top + g.members.length * (MINI_H + MINI_GAP) - MINI_GAP + FRAME_PADDING.bottom;
      const minis = g.members.map((n, i) => {
        const box = step(n);
        // one line: number, badge, name, progress, focus button
        const w = Math.min(300, Math.max(160, Math.round(136 + box.name.length * CHAR_W)));
        return { ...box, depth: g.depth, x: x + FRAME_PADDING.left, y: y + FRAME_PADDING.top + i * (MINI_H + MINI_GAP), w, h: MINI_H, mini: true, frame: g.key };
      });
      const frame = cls(g);
      // the head: badge, name of the class, layer, progress, focus button
      const head = Math.min(360, Math.round(112 + frame.name.length * CHAR_W + areaLabel(frame.area).length * 6.5));
      const w = Math.max(head, Math.max(...minis.map((m) => m.w)) + FRAME_PADDING.left + FRAME_PADDING.right);
      frames.push({ ...frame, depth: g.depth, x, y, w, h, mini: false, frame: null });
      boxes.push(...minis);
      y += h + ROW_GAP + 8;
    }
    return { frames, boxes };
  });

  /** What the layout was computed for: level, boxes with their sizes and frames, connections. */
  private readonly layoutKey = computed(() => {
    const { frames, boxes } = this.sketch();
    return [
      this.flow().id, this.level(),
      frames.map((f) => `${f.key}:${f.w}`).join(','),
      boxes.map((b) => `${b.key}:${b.w}:${b.h}:${b.frame ?? ''}`).join(','),
      this.links().map((l) => l.from + '>' + l.to).join(','),
    ].join('|');
  });
  /** The layout of the engine (ELK) with the key it was computed for; null until the first one arrives. */
  private readonly placed = signal<{ key: string; layout: Layout } | null>(null);
  /** Boxes moved by hand, per diagram (layoutKey): kept while the view lives, so a flow looks the same on return. */
  private readonly movedByKey = new Map<string, ReadonlyMap<string, Point>>();
  /** Where the user put the boxes of this diagram (box key -> place); the others follow the layout. */
  protected readonly moved = linkedSignal<string, ReadonlyMap<string, Point>>({
    source: () => this.layoutKey(),
    computation: (key) => this.movedByKey.get(key) ?? new Map(),
  });
  /** The box being dragged: its connections follow at once, without the usual transition. */
  protected readonly dragging = signal(false);
  private drag: { keys: string[]; start: Point; origin: Map<string, Point>; min: Point; moved: boolean } | null = null;
  /** A drag just ended: the click that follows must not jump to the code. */
  private justDragged = false;

  /**
   * The diagram as it is drawn: every box where the user put it, else where the layout engine put it, else in the
   * sketch; a frame as the engine sized it, or - once one of its boxes was moved - around its boxes.
   */
  private readonly layout = computed(() => {
    const sketch = this.sketch();
    const placed = this.placed();
    const auto = placed?.key === this.layoutKey() ? placed.layout : null;
    const moved = this.moved();
    const boxes = sketch.boxes.map((b) => {
      const at = moved.get(b.key) ?? auto?.boxes.get(boxId(b.key));
      return at ? { ...b, x: at.x, y: at.y } : b;
    });
    const frames = sketch.frames.map((f) => {
      const inside = boxes.filter((b) => b.frame === f.key);
      const sized = inside.some((b) => moved.has(b.key)) ? undefined : auto?.frames.get(frameId(f.key));
      const around = frameAround(inside);
      // a frame around moved boxes keeps the width its head needs
      const rect = sized ?? { ...around, w: Math.max(around.w, f.w) };
      return { ...f, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    });
    return { frames, boxes, auto };
  });

  protected readonly boxes = computed(() => this.layout().boxes);
  /** Combined level: the frames of the classes around the boxes of their steps. */
  protected readonly frames = computed(() => this.layout().frames);
  /** The user moved boxes of this diagram. */
  protected readonly hasMoved = computed(() => this.moved().size > 0);

  /** The connections between the steps shown: the calls of the flow, and dashed ones around removed areas. */
  private readonly stepLinks = computed<Link[]>(() => {
    const nodes = this.nodes();
    const shown = new Set(nodes.map((n) => n.step.segmentId));
    const links: Link[] = this.flow().edges
      .map((e, i) => ({ e, c: edgeColorIndex(i) }))
      .filter(({ e }) => shown.has(e.from) && shown.has(e.to))
      .map(({ e, c }) => {
        const http = e.kind === 'http';
        const run = this.runs().edges.get(e.from + '>' + e.to);
        const contract = http ? contractLines(run, e.via, this.store.testName()) : [];
        const title = [http ? 'HTTP ' + e.via : e.via, ...(run ? [edgeTitle(run, this.store.testName())] : []), ...contract].join('\n');
        return { from: e.from, to: e.to, ends: [e.from, e.to], c, http, run: run?.status ?? null, both: http && bothSides(run), bridged: false, title };
      });
    // around removed areas: from the caller shown to the step, dashed, in the colour of the call into the step
    const direct = new Set(links.map((l) => l.from + '>' + l.to));
    for (const n of nodes) {
      if (!n.bridged.length || !n.caller || direct.has(n.caller + '>' + n.step.segmentId)) {
        continue;
      }
      const into = this.flow().edges.findIndex((e) => e.to === n.step.segmentId && e.from === n.step.parentSegmentId);
      links.push({
        from: n.caller, to: n.step.segmentId, ends: [n.caller, n.step.segmentId], c: edgeColorIndex(Math.max(0, into)), http: false, run: null,
        both: false, bridged: true, title: t('Über entfernte Bereiche: {areas}', { areas: n.bridged.join(', ') }),
      });
    }
    return links;
  });

  /** The connections of the diagram at its level: between steps, or combined between classes. */
  private readonly links = computed<Link[]>(() => {
    const links = this.stepLinks();
    if (this.level() !== 'class') {
      return links;
    }
    const keyOf = new Map(this.classes().flatMap((g) => g.members.map((m) => [m.step.segmentId, g.key] as const)));
    const name = (id: string) => shortName(this.store.segments().get(id)?.symbol ?? id);
    return classLinks(links, (id) => keyOf.get(id)).map((l) => {
      const http = l.edges.filter((e) => e.http);
      return {
        from: l.from, to: l.to, ends: [...new Set(l.edges.flatMap((e) => e.ends))], c: l.edges[0].c, http: http.length > 0,
        run: weakest(l.edges.map((e) => e.run), EDGE_RUNS), both: http.length > 0 && http.every((e) => e.both),
        bridged: l.edges.every((e) => e.bridged),
        title: l.edges.map((e) => `${name(e.from)} → ${name(e.to)}\n${e.title}`).join('\n\n'),
      };
    });
  });

  protected readonly diagram = computed(() => {
    const { boxes, frames, auto } = this.layout();
    const moved = this.moved();
    const byKey = new Map(boxes.map((b) => [b.key, b]));
    let right = 0;
    let bottom = 0;
    const edges = this.links().flatMap((l, i) => {
      const a = byKey.get(l.from);
      const b = byKey.get(l.to);
      if (!a || !b) {
        return [];
      }
      // the route of the layout engine, at right angles around the boxes - unless an end was moved by hand
      const route = moved.has(l.from) || moved.has(l.to) ? undefined : auto?.routes.get(edgeId(i));
      if (route) {
        right = Math.max(right, ...route.map((p) => p.x));
        bottom = Math.max(bottom, ...route.map((p) => p.y));
        const middle = routeMiddle(route);
        // a call back to an earlier step runs to the left: dashed
        return [{ ...l, d: routePath(route), back: route[route.length - 1].x < route[0].x - 1, lx: middle.x, ly: middle.y - 5 }];
      }
      const curve = curvePath(a, b);
      return [{ ...l, d: curve.d, back: b.x + b.w <= a.x, lx: curve.middle.x, ly: curve.middle.y - 5 }];
    });
    const all = [...boxes, ...frames];
    const width = Math.max(right, ...all.map((b) => b.x + b.w), 0) + 48;
    const height = Math.max(bottom, ...all.map((b) => b.y + b.h), 0) + 12;
    return { edges, width, height };
  });

  /**
   * The cards of the code. Class level: a class each, with its steps in file order. Method level: the steps in call
   * order, consecutive steps of one class in one card under the name of the class.
   */
  protected readonly codeCards = computed<Card[]>(() => {
    const split = this.store.diffMode() === 'split';
    const files = (members: Node[]) => [...new Set(members.map((m) => this.fileOf(m.segment)))].join(' · ');
    if (this.codeLevel() === 'inline') {
      return []; // by line: see inlineRoots
    }
    if (this.codeLevel() === 'class') {
      return this.classes().map((g) => {
        const members = inFileOrder(g.members);
        return {
          key: g.key, framed: true, classKey: g.key, name: g.name, files: files(members), area: this.areaOf(g.members[0].segment),
          depth: g.depth, members: members.map((node) => ({ node, indent: 0 })), ids: members.map((m) => m.step.segmentId), others: [],
          wide: split && members.some((m) => splits(m.segment)),
        };
      });
    }
    const segs = this.store.segments();
    const components = this.store.componentBySegment();
    const byClass = new Map(this.classes().map((g) => [g.key, g.members]));
    return classRuns(this.nodes(), (id) => classOf(segs.get(id)!, components.get(id))).map((r) => {
      const ids = r.members.map((m) => m.step.segmentId);
      return {
        key: r.key + '@' + ids[0], framed: false, classKey: r.key, name: r.name, files: files(r.members), area: this.areaOf(r.members[0].segment),
        depth: r.depth, members: r.members.map((node) => ({ node, indent: node.depth - r.depth })), ids,
        others: (byClass.get(r.key) ?? []).filter((m) => !ids.includes(m.step.segmentId))
          .map((m) => ({ id: m.step.segmentId, no: m.no, name: this.nodeName(m.segment) })),
        wide: split && r.members.some((m) => splits(m.segment)),
      };
    });
  });

  /**
   * The code by line: from every entry point its block, and inside each block the blocks it calls, right after the
   * calling line (inlineTree). A step called from several lines is there several times; marks are kept per line of
   * code, so they show in all of them alike.
   */
  protected readonly inlineRoots = computed<InlineStep[]>(() => this.codeLevel() !== 'inline' ? [] : inlineTree(
    this.nodes().map((n) => ({ id: n.step.segmentId, caller: n.caller })),
    this.flow().edges,
  ));
  private readonly nodeById = computed(() => new Map(this.nodes().map((n) => [n.step.segmentId, n])));

  /** What "Einzeln durchgehen" walks through: step by step, or class by class. */
  protected readonly units = computed<Unit[]>(() => this.codeLevel() === 'class'
    ? this.codeCards().map((c) => ({ key: c.key, framed: true, ids: c.ids }))
    : this.nodes().map((n) => ({ key: n.step.segmentId, framed: false, ids: [n.step.segmentId] })));

  protected readonly stepOf = computed(() => {
    const map: Record<string, number> = {};
    this.allSteps().forEach((n) => (map[n.step.segmentId] = n.no));
    return map;
  });

  protected readonly progress = computed(() => this.store.progressOf(this.slots()));

  private readonly slots = computed(() => this.flow().steps.map((s) => ({ segmentId: s.segmentId, place: this.place() })));

  /** Segment ids whose code is shown. */
  protected readonly visible = computed<ReadonlySet<string>>(() => {
    const i = this.stepIndex();
    if (i != null) {
      return new Set(this.units()[i]?.ids ?? []);
    }
    const hidden = this.hidden();
    const hideDone = this.hideDone();
    return new Set(this.nodes().map((n) => n.step.segmentId)
      .filter((id) => !hidden.has(id) && !(hideDone && this.isDone(id)) && this.store.inCommitSegment(id)));
  });

  protected readonly hiddenCount = computed(() => this.nodes().length - this.visible().size);

  constructor() {
    // Let the layout engine place the diagram whenever its boxes or connections change.
    effect(() => {
      const key = this.layoutKey();
      const { frames, boxes } = this.sketch();
      const links = this.links();
      untracked(() => {
        layoutFlow({
          boxes: boxes.map((b) => ({ key: boxId(b.key), w: b.w, h: b.h, frame: b.frame ? frameId(b.frame) : null })),
          frames: frames.map((f) => ({ key: frameId(f.key), minW: f.w })),
          edges: links.map((l, i) => ({ id: edgeId(i), from: boxId(l.from), to: boxId(l.to) })),
        }).then((layout) => {
          if (this.layoutKey() === key) {
            this.placed.set({ key, layout });
          }
        }).catch(() => {
          // the engine could not be loaded or failed: the sketch stays
        });
      });
    });
    // Lay out the connectors once the cards are rendered (and again when they change size).
    afterRenderEffect((onCleanup) => {
      this.codeCards();
      this.inlineRoots();
      this.visible();
      this.gutter();
      this.indent();
      this.store.ok();
      this.store.okAt();
      this.store.comments();
      this.store.collapseDone();
      this.store.diffMode();
      const host = this.cards().nativeElement;
      const observer = new ResizeObserver(() => this.layoutConnectors());
      observer.observe(host);
      this.layoutConnectors();
      onCleanup(() => observer.disconnect());
    });
    // Another flow in the same view: the cards start at the left/top (only the editor scrolls vertically).
    afterRenderEffect(() => {
      this.flow().id;
      const host = untracked(() => this.cards().nativeElement);
      host.scrollTop = 0;
      host.scrollLeft = 0;
    });
    afterRenderEffect(() => {
      const target = this.store.focusSegment();
      this.visible();
      this.codeCards();
      this.inlineRoots();
      if (target && this.stepOf()[target] && this.scrollIntoView(target)) {
        this.store.focusSegment.set(null);
      }
    });
  }

  // ------------------------------------------------------------------ levels

  /** Level of the diagram; the code follows unless it has its own level. */
  protected setLevel(level: FlowDiagramLevel): void {
    this.store.setFlowPage(this.flow().id, { level });
  }

  /** An own level for the code, whatever the diagram shows. */
  protected setCodeLevel(level: FlowCodeLevel): void {
    this.store.setFlowPage(this.flow().id, { code: level });
  }

  /** Lets the code follow the diagram again, or pins the level it has now. */
  protected toggleCodeFollows(): void {
    this.store.setFlowPage(this.flow().id, { code: this.codeFollows() ? this.codeLevel() : null });
  }

  // ------------------------------------------------------------------ boxes of the diagram

  protected isHot(ids: readonly string[]): boolean {
    const hovered = this.hovered();
    return !!hovered && ids.some((id) => hovered.has(id));
  }

  protected hover(ids: readonly string[] | null): void {
    this.hovered.set(ids ? new Set(ids) : null);
  }

  /** Pointer on the name of a class in the code: all its steps of the flow, here and in its other runs. */
  protected hoverClass(card: Card | null): void {
    this.hoveredClass.set(card?.classKey ?? null);
    this.hover(card ? [...card.ids, ...card.others.map((o) => o.id)] : null);
  }

  /** The step of a block of the code by line. */
  protected nodeOf(id: string): Node | undefined {
    return this.nodeById().get(id);
  }

  /** Pointer over a block of the code by line: the innermost block under it counts, not the ones around it. */
  protected hoverInner(event: Event, id: string): void {
    event.stopPropagation();
    if (!this.hovered()?.has(id) || this.hovered()?.size !== 1) {
      this.hover([id]);
    }
  }

  /** A step of the card is shown (in step-by-step mode only the current card has one). */
  protected anyVisible(ids: readonly string[]): boolean {
    return ids.some((id) => this.visible().has(id));
  }

  protected isDone(id: string): boolean {
    const p = this.nodeProgress(id);
    return p.total > 0 && p.ok === p.total;
  }

  protected progressOf(ids: readonly string[]): { ok: number; total: number } {
    return this.store.progressOf(ids.map((segmentId) => ({ segmentId, place: this.place() })));
  }

  /** None of the steps is shown in the code. */
  protected isOff(ids: readonly string[]): boolean {
    return !ids.some((id) => this.visible().has(id));
  }

  /** All steps are hidden by the user. */
  protected allHidden(ids: readonly string[]): boolean {
    return ids.every((id) => this.hidden().has(id));
  }

  /** None of the steps is changed by the selected commit. */
  protected otherCommit(ids: readonly string[]): boolean {
    return !ids.some((id) => this.store.inCommitSegment(id));
  }

  /** The card shown in step-by-step mode holds one of the steps. */
  protected isCurrent(ids: readonly string[]): boolean {
    const i = this.stepIndex();
    const current = i == null ? null : this.units()[i];
    return !!current && ids.some((id) => current.ids.includes(id));
  }

  /** Hides the steps of a box, or shows them again when all are hidden. */
  protected toggleHidden(ids: readonly string[], event: Event): void {
    event.stopPropagation();
    const next = new Set(this.hidden());
    const show = this.allHidden(ids);
    ids.forEach((id) => (show ? next.delete(id) : next.add(id)));
    this.hidden.set(next);
    this.stepIndex.set(null);
  }

  /** The steps outside the branches of the given steps (what they call, and what those call). */
  private outside(ids: readonly string[]): Set<string> {
    return intersect(ids.map((id) => outsideBranch(this.flow().steps, this.flow().edges, id)));
  }

  /**
   * Hides every step outside this box's branch (what it calls, and what those call), exactly as if each had been
   * hidden with its eye: they stay in the diagram and can be shown again one by one. Again on the focused box: all back.
   */
  protected focusOn(box: { key: string; ids: string[] }, event: Event): void {
    event.stopPropagation();
    if (this.focused() === box.key) {
      this.hidden.set(new Set());
    } else {
      this.hidden.set(this.outside(box.ids));
      this.lastFocus.set({ key: box.key, ids: box.ids });
    }
    this.stepIndex.set(null);
  }

  /**
   * Starts moving boxes with the pointer: one box, or - on the head of a frame - all boxes of the class. Nothing
   * moves before the pointer has gone a few pixels, so a click still jumps to the code.
   */
  protected dragStart(event: PointerEvent, keys: readonly string[]): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) {
      return;
    }
    const boxes = this.boxes().filter((b) => keys.includes(b.key));
    if (!boxes.length) {
      return;
    }
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // no capture (a pointer that is gone already): the drag ends when the pointer leaves the box
    }
    // a box stays in the diagram, a box of a class leaves room for the head and the border of its frame
    const framed = boxes.some((b) => b.frame);
    this.drag = {
      keys: boxes.map((b) => b.key),
      start: { x: event.clientX, y: event.clientY },
      origin: new Map(boxes.map((b) => [b.key, { x: b.x, y: b.y }])),
      min: { x: Math.min(...boxes.map((b) => b.x)) - (framed ? FRAME_PADDING.left : 0), y: Math.min(...boxes.map((b) => b.y)) - (framed ? FRAME_PADDING.top : 0) },
      moved: false,
    };
  }

  protected dragMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) {
      return;
    }
    let dx = event.clientX - drag.start.x;
    let dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) {
      return;
    }
    drag.moved = true;
    this.dragging.set(true);
    dx = Math.max(dx, -drag.min.x);
    dy = Math.max(dy, -drag.min.y);
    const next = new Map(this.moved());
    for (const key of drag.keys) {
      const at = drag.origin.get(key)!;
      next.set(key, { x: Math.round(at.x + dx), y: Math.round(at.y + dy) });
    }
    this.movedByKey.set(this.layoutKey(), next);
    this.moved.set(next);
  }

  protected dragEnd(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) {
      return;
    }
    const el = event.currentTarget as HTMLElement;
    if (el.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      this.dragging.set(false);
      this.justDragged = true;
      setTimeout(() => (this.justDragged = false));
    }
  }

  /** Puts all boxes back where the layout placed them. */
  protected resetLayout(): void {
    this.movedByKey.delete(this.layoutKey());
    this.moved.set(new Map());
  }

  /** Jumps to the code of a box: to the step, or to the class (its first step in the card or in call order). */
  protected openBox(box: Box): void {
    if (this.justDragged) {
      return; // the click that ends a drag
    }
    if (box.ids.length > 1) {
      // a class: bring back all its steps, then go to the top of its card (or to its first call)
      const next = new Set(this.hidden());
      box.ids.forEach((id) => next.delete(id));
      this.hidden.set(next);
    }
    const card = this.codeCards().find((c) => c.framed && c.key === box.key);
    this.scrollTo(card ? card.ids[0] : box.ids[0]);
  }

  /** Run status of the steps of a box (Mock-Grenzen): the weakest; null without flow coverage (older analyses). */
  protected runOf(ids: readonly string[]): StepRunStatus | null {
    return weakest(ids.map((id) => this.runs().steps.get(id)?.status), STEP_RUNS);
  }

  /** Tooltip of a box: which tests run it for real, which only mock it, and the mock warnings on it. */
  protected runTitle(ids: readonly string[]): string {
    const title = (id: string) => stepTitle(this.runs().steps.get(id), this.store.testName(), this.store.mockWarningsBySegment().get(id) ?? []);
    if (ids.length === 1) {
      return title(ids[0]);
    }
    const segs = this.store.segments();
    return ids.map((id) => {
      const detail = title(id);
      return `${this.stepOf()[id] ?? ''} ${this.nodeName(segs.get(id)!)}${detail ? '\n' + detail : ''}`;
    }).join(this.hasRuns() ? '\n\n' : '\n');
  }

  /** A changed test stubs a function of the box (mock warning). */
  protected mockWarned(ids: readonly string[]): boolean {
    return this.store.testInfo() && ids.some((id) => this.store.mockWarningsBySegment().has(id));
  }

  // ------------------------------------------------------------------ areas

  /** Takes an area out of the overview (diagram and code) or brings it back; the last area left stays. */
  protected toggleArea(id: string): void {
    const next = new Set(this.hiddenAreas());
    if (next.has(id)) {
      next.delete(id);
    } else if (this.areas().some((a) => a.id !== id && !a.removed)) {
      next.add(id);
    }
    this.store.setFlowPage(this.flow().id, { hiddenAreas: next });
    this.stepIndex.set(null);
  }

  protected showAllAreas(): void {
    const next = new Set(this.hiddenAreas());
    this.areas().forEach((a) => next.delete(a.id));
    this.store.setFlowPage(this.flow().id, { hiddenAreas: next });
  }

  /** The area cannot be removed: it is the only one left. */
  protected lastArea(id: string): boolean {
    return this.areas().every((a) => a.id === id || a.removed);
  }

  // ------------------------------------------------------------------ focus tools

  protected showAll(): void {
    this.hidden.set(new Set());
    this.hideDone.set(false);
    this.stepIndex.set(null);
  }

  protected startSteps(): void {
    const firstOpen = this.units().findIndex((u) => u.ids.some((id) => !this.isDone(id)));
    this.stepIndex.set(Math.max(0, firstOpen));
  }

  protected step(delta: number): void {
    const i = this.stepIndex() ?? 0;
    this.stepIndex.set(Math.min(this.units().length - 1, Math.max(0, i + delta)));
  }

  /** Marks the current card (a step, or all steps of a class) as ok here and moves on to the next one. */
  protected okAndNext(): void {
    const unit = this.units()[this.stepIndex() ?? 0];
    if (!unit) return;
    const lines = this.store.linesOf(unit.ids.map((segmentId) => ({ segmentId, place: this.place() })));
    this.store.mark(lines, true, unit.framed ? `class:${unit.key}` : `segment:${unit.key}`);
    if ((this.stepIndex() ?? 0) < this.units().length - 1) {
      this.step(1);
    } else {
      this.stepIndex.set(null);
      this.store.notify(t('Flow durchgearbeitet'));
    }
  }

  /** Marks all steps of a class as ok here, or takes the marks back when all were ok. */
  protected markUnit(unit: Card, event: Event): void {
    event.stopPropagation();
    this.store.toggle(this.store.linesOf(unit.ids.map((segmentId) => ({ segmentId, place: this.place() }))), `class:${unit.key}`);
  }

  // ------------------------------------------------------------------ steps

  protected calledBy(node: Node): string | null {
    const parent = node.step.parentSegmentId;
    if (!parent) {
      return null;
    }
    const edge = this.flow().edges.find((e) => e.from === parent && e.to === node.step.segmentId);
    const caller = this.store.segments().get(parent);
    const name = caller?.symbol ?? caller?.path ?? parent;
    const how = edge?.kind === 'http' ? t('per HTTP {via}', { via: edge.via }) + ' ' : '';
    return how + t('aufgerufen von {step} {name}', { step: this.stepOf()[parent] ?? '', name: shortName(name) })
      + (edge?.line ? ' · ' + t('Zeile {line}', { line: edge.line }) : '');
  }

  /** Method/function name only; the class goes into the second line. */
  protected nodeName(seg: Segment): string {
    const name = seg.symbol ?? this.fileOf(seg);
    return name.substring(name.lastIndexOf('.') + 1);
  }

  /** Layer of a step (frontend, api, domain, ...) for the coloured stripe and tag. */
  protected areaOf(seg: Segment): string | null {
    return areaOfSegment(seg, this.store.areaBySegment());
  }

  protected calledByColor(node: Node): string | null {
    const parent = node.step.parentSegmentId;
    return parent ? this.edgeColors()[parent + '>' + node.step.segmentId] ?? null : null;
  }

  protected nodeHint(seg: Segment): string {
    const sym = seg.symbol ?? '';
    const container = sym.includes('.') ? sym.substring(0, sym.lastIndexOf('.')) + ' · ' : '';
    return container + this.fileOf(seg);
  }

  protected fileOf(seg: Segment): string {
    return seg.path.substring(seg.path.lastIndexOf('/') + 1);
  }

  protected nodeProgress(id: string): { ok: number; total: number } {
    return this.store.progressOf([{ segmentId: id, place: this.place() }]);
  }

  protected markFlow(): void {
    this.store.toggle(this.store.linesOf(this.slots()), `flow:${this.flow().id}`);
  }

  /** Jumps to a step (making it visible first); segments outside this flow are shown at their own place. */
  protected scrollTo(segmentId: string): void {
    const removedStep = this.allSteps().find((s) => s.step.segmentId === segmentId && this.hiddenAreas().has(s.area));
    if (removedStep) {
      // a step of a removed area: bring the area back rather than leaving the flow
      const next = new Set(this.hiddenAreas());
      next.delete(removedStep.area);
      this.store.setFlowPage(this.flow().id, { hiddenAreas: next });
    }
    if (!this.nodes().some((n) => n.step.segmentId === segmentId)) {
      this.store.reveal(segmentId);
      return;
    }
    if (!this.visible().has(segmentId)) {
      if (this.stepIndex() != null) {
        this.stepIndex.set(this.units().findIndex((u) => u.ids.includes(segmentId)));
      } else {
        const next = new Set(this.hidden());
        next.delete(segmentId);
        this.hidden.set(next);
        if (this.hideDone() && this.isDone(segmentId)) {
          this.hideDone.set(false);
        }
      }
    }
    this.store.focusSegment.set(segmentId);
  }

  private scrollIntoView(segmentId: string): boolean {
    const el = this.cards().nativeElement.querySelector<HTMLElement>(`app-code-block[data-segment="${segmentId}"]`);
    if (!el) {
      return false;
    }
    // the first block of a class card: show the head of the class too
    const card = el.closest<HTMLElement>('.class-card');
    (card && card.querySelector('app-code-block') === el ? card : el).scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
    const line = this.store.takeFocusLine(segmentId);
    if (line != null) {
      flashLine(el, line);
    }
    return true;
  }

  protected scrollToParent(node: Node): void {
    if (node.step.parentSegmentId) {
      this.scrollTo(node.step.parentSegmentId);
    }
  }

  /**
   * Draws, in the left margin, one line per call: from the call-site line to the header of the called step.
   * Every line gets its own lane (LANE px apart); lanes are reused where lines do not overlap vertically.
   * Long lines take the outer lanes and short ones the inner lanes, so they cross as little as possible.
   */
  private layoutConnectors(): void {
    if (this.codeLevel() === 'inline') {
      // by line the called block stands right below its call: no lines in the margin, no margin
      this.connectors.set([]);
      this.gutter.set(0);
      this.railHeight.set(0);
      this.railWidth.set(0);
      return;
    }
    const host = this.cards().nativeElement;
    const box = host.getBoundingClientRect();
    const scroll = host.scrollLeft;
    // screen px -> layout px (1 unless the page is scaled, e.g. a zoomed-out preview)
    const k = host.offsetWidth > 0 && box.width > 0 ? host.offsetWidth / box.width : 1;
    const items: { edge: FlowEdge; c: number; fromX: number; toX: number; y1: number; y2: number; lane: number }[] = [];
    for (const [i, edge] of this.flow().edges.entries()) {
      const fromEl = host.querySelector<HTMLElement>(`app-code-block[data-segment="${edge.from}"]`);
      const toEl = host.querySelector<HTMLElement>(`app-code-block[data-segment="${edge.to}"]`);
      if (!fromEl || !toEl) {
        continue;
      }
      const lineEl = edge.line != null ? fromEl.querySelector<HTMLElement>(`.row[data-new="${edge.line}"]`) : null;
      const fromRect = (lineEl ?? fromEl.querySelector<HTMLElement>('.head') ?? fromEl).getBoundingClientRect();
      const toHead = (toEl.querySelector<HTMLElement>('.head') ?? toEl).getBoundingClientRect();
      items.push({
        edge,
        c: edgeColorIndex(i),
        fromX: (fromEl.getBoundingClientRect().left - box.left) * k + scroll,
        toX: (toEl.getBoundingClientRect().left - box.left) * k + scroll,
        y1: (fromRect.top - box.top + fromRect.height / 2) * k,
        y2: (toHead.top - box.top + toHead.height / 2) * k,
        lane: 0,
      });
    }
    // lane assignment: longest first, each into the outermost lane that is free over its whole height
    const lanes: [number, number][][] = [];
    for (const item of [...items].sort((a, b) => Math.abs(b.y2 - b.y1) - Math.abs(a.y2 - a.y1))) {
      const lo = Math.min(item.y1, item.y2) - 8;
      const hi = Math.max(item.y1, item.y2) + 8;
      let lane = lanes.findIndex((used) => used.every(([a, b]) => b < lo || a > hi));
      if (lane < 0) {
        lane = lanes.length;
        lanes.push([]);
      }
      lanes[lane].push([lo, hi]);
      item.lane = lane;
    }
    const result: Connector[] = items.map((item) => {
      const x = 8 + item.lane * LANE;
      const r = 5;
      const { fromX, toX, y1, y2 } = item;
      const dir = y2 > y1 ? 1 : -1;
      const d = `M ${fromX - 2} ${y1} H ${x + r} Q ${x} ${y1}, ${x} ${y1 + r * dir} V ${y2 - r * dir} Q ${x} ${y2}, ${x + r} ${y2} H ${toX - 3}`;
      return { d, from: item.edge.from, to: item.edge.to, c: item.c, http: item.edge.kind === 'http' };
    });
    this.gutter.set(Math.max(MIN_GUTTER, 8 + lanes.length * LANE + 14));
    // Size of the blocks, not host.scrollHeight/-Width: those include the rails themselves, so the rails could never
    // shrink again (a shorter flow, collapsed blocks) and made the cards scroll inside, hiding the blocks.
    const content = contentSize(host);
    this.railHeight.set(content.height);
    this.railWidth.set(content.width);
    this.connectors.set(result);
  }
}

/** Extent of the cards' children in layout px, leaving out the absolutely positioned rails. */
export function contentSize(host: HTMLElement): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const child of Array.from(host.children)) {
    if (!(child instanceof HTMLElement)) {
      continue; // the rails are an SVG element
    }
    width = Math.max(width, child.offsetLeft + child.offsetWidth);
    height = Math.max(height, child.offsetTop + child.offsetHeight);
  }
  return { width, height };
}

/** Ids for the layout engine: boxes, frames and edges share one namespace there. */
function boxId(key: string): string {
  return 'b:' + key;
}

function frameId(key: string): string {
  return 'f:' + key;
}

function edgeId(index: number): string {
  return 'e' + index;
}

/** The block of a segment is shown side by side when that view is on (it has removed and added lines). */
function splits(seg: Segment): boolean {
  return diffSides(seg.lines) === 'both';
}

function shortName(name: string): string {
  const parts = name.split('.');
  return parts.length > 1 && parts[parts.length - 1] ? parts.slice(-2).join('.') : name;
}
