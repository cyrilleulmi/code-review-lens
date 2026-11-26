/**
 * Layout of the sequence diagram of a data flow (flow-sequence.ts): a lifeline per class in the order they are first
 * called, a row per call from top to bottom, and on the lifelines the bars that show how long a step runs. Pure
 * geometry - sequence-diagram.ts draws it. The widths come from the texts: every label fits between the lifelines it
 * connects.
 */
import { FlowSequence, SequenceCall } from './flow-sequence';

/** Who a lifeline stands for: the class (component) of a step, else its file. */
export interface Participant {
  key: string;
  name: string;
  area: string | null;
}

export interface Lifeline extends Participant {
  /** centre of the lifeline */
  x: number;
  /** width of its head */
  w: number;
}

/** A row of the diagram: the arrow of a call, or - call null - the arrow from outside into an entry point. */
export interface Message {
  call: SequenceCall | null;
  /** segment id of the step the arrow points at */
  to: string;
  /** index of the row, from 0 */
  row: number;
  /** vertical centre of the row */
  y: number;
  /** start and end of the arrow */
  x1: number;
  x2: number;
  /** a call within the class: a loop on its lifeline */
  self: boolean;
  label: string;
  /** left end of the label (its bubble with the number comes first) */
  lx: number;
  /** baseline of the label */
  ly: number;
  /** the arrow as an SVG path */
  d: string;
}

/** The bar on a lifeline while a step runs. */
export interface Activation {
  /** key of the lifeline */
  key: string;
  /** the call that started it; 0 = an entry point */
  no: number;
  /** the calls during which it runs: from `start` (the call itself; the first call of an entry point) to `end` */
  start: number;
  end: number;
  /** the row it starts in */
  row: number;
  /** left edge; a step called while its class is already running stands a little to the right */
  x: number;
  y1: number;
  y2: number;
}

export interface SequenceLayout {
  lifelines: Lifeline[];
  messages: Message[];
  activations: Activation[];
  width: number;
  height: number;
}

/** Height of a row: the list of calls beside the diagram uses the same, so its rows line up with the arrows. */
export const SEQUENCE_ROW = 32;
/** Room above the first row: the heads of the lifelines. */
export const SEQUENCE_HEAD = 46;
/** Height of the head of a lifeline. */
export const SEQUENCE_HEAD_BOX = 30;
/** Width of the bubble with the number in front of a label. */
export const SEQUENCE_BUBBLE = 18;

/** Width of a bar, and how far a bar of the same class inside another one stands to the right. */
const BAR = 10;
const NEST = 5;
/** How far the loop of a call within a class reaches out. */
const LOOP = 26;
/** Width of a character of the label font (11px code font) and of the head font (12px code font). */
const LABEL_CHAR = 6.7;
const HEAD_CHAR = 7.3;
/** Air between a label and the lifelines beside it, and between two heads. */
const LABEL_AIR = 26;
const HEAD_GAP = 22;
/** An arrow with this much more room than its label needs is a long one: its label stands at its start. */
const LONG_ARROW = 220;
/** The arrow of a row runs a little below its centre, the label stands above it. */
const ARROW_DY = 7;
const LABEL_DY = -3;

/** Width of a label with its bubble. */
export function labelWidth(label: string): number {
  return SEQUENCE_BUBBLE + 5 + Math.ceil(label.length * LABEL_CHAR);
}

/**
 * Places the sequence. participantOf: the class of a step; labelOf: the text of a row - what is called (call null:
 * the entry point itself).
 */
export function sequenceLayout(
  sequence: FlowSequence,
  participantOf: (segmentId: string) => Participant,
  labelOf: (segmentId: string, call: SequenceCall | null) => string,
): SequenceLayout {
  // the rows: every entry point, followed by its calls
  const rows: { call: SequenceCall | null; to: string }[] = [];
  sequence.entries.forEach((entry, i) => {
    const until = sequence.entries[i + 1]?.after ?? sequence.calls.length;
    rows.push({ call: null, to: entry.id });
    sequence.calls.slice(entry.after, until).forEach((call) => rows.push({ call, to: call.to }));
  });
  const rowOf = new Map<number, number>();
  rows.forEach((r, i) => r.call && rowOf.set(r.call.no, i));
  const yOf = (row: number) => SEQUENCE_HEAD + row * SEQUENCE_ROW + SEQUENCE_ROW / 2;

  // the lifelines, in the order their classes come up
  const order: Participant[] = [];
  const index = new Map<string, number>();
  const lifelineOf = (segmentId: string): number => {
    const p = participantOf(segmentId);
    let i = index.get(p.key);
    if (i == null) {
      i = order.length;
      index.set(p.key, i);
      order.push(p);
    }
    return i;
  };
  const ends = rows.map((r) => ({ from: r.call ? lifelineOf(r.call.from) : -1, to: lifelineOf(r.to) }));
  const labels = rows.map((r) => labelOf(r.to, r.call));
  const widths = order.map((p) => Math.min(280, Math.max(96, Math.round(p.name.length * HEAD_CHAR) + 34)));

  // room every label needs: between two lifelines, right of a lifeline (a loop), or left of it (an entry point)
  const between: { i: number; j: number; need: number }[] = [];
  const left = order.map(() => 0);
  const right = order.map(() => 0);
  rows.forEach((r, n) => {
    const { from, to } = ends[n];
    const need = labelWidth(labels[n]) + LABEL_AIR;
    if (!r.call) {
      left[to] = Math.max(left[to], need + 12);
    } else if (from === to) {
      right[to] = Math.max(right[to], LOOP + need + 2 * NEST);
    } else {
      between.push({ i: Math.min(from, to), j: Math.max(from, to), need: need + 2 * NEST });
    }
  });
  const xs: number[] = [];
  order.forEach((_, j) => {
    let x = Math.max(widths[j] / 2 + 6, left[j]);
    if (j > 0) {
      x = Math.max(x, xs[j - 1] + (widths[j - 1] + widths[j]) / 2 + HEAD_GAP, xs[j - 1] + right[j - 1] + left[j]);
    }
    for (const c of between) {
      if (c.j === j) {
        x = Math.max(x, xs[c.i] + c.need);
      }
    }
    xs.push(Math.round(x));
  });
  const lifelines: Lifeline[] = order.map((p, i) => ({ ...p, x: xs[i], w: widths[i] }));

  // the bars and arrows, row by row; `open` = the steps running, innermost last
  const activations: Activation[] = [];
  const messages: Message[] = [];
  let open: { line: number; level: number; end: number }[] = [];
  const levelOn = (line: number) => open.filter((a) => a.line === line).length;
  const bar = (line: number, level: number, no: number, start: number, end: number, row: number, depth: number): void => {
    const y1 = yOf(row) + ARROW_DY - 4;
    const last = rowOf.get(end) ?? row;
    // a step inside another ends a little earlier, so the ends of nested bars stay apart
    const y2 = Math.max(y1 + 11, yOf(last) + SEQUENCE_ROW / 2 - 3 * Math.min(depth + 1, 3));
    activations.push({ key: order[line].key, no, start, end, row, x: xs[line] + level * NEST - BAR / 2, y1, y2 });
    open.push({ line, level, end });
  };
  rows.forEach((r, row) => {
    const y = yOf(row);
    const label = labels[row];
    const { from, to } = ends[row];
    const ly = y + LABEL_DY;
    if (!r.call) {
      // an entry point: everything before it is over; the arrow comes from outside
      open = [];
      const entry = sequence.entries.find((e) => e.id === r.to)!;
      const next = sequence.entries[sequence.entries.indexOf(entry) + 1];
      const x2 = xs[to] - BAR / 2;
      const x1 = Math.max(4, x2 - labelWidth(label) - 18);
      messages.push({ call: null, to: r.to, row, y, x1, x2, self: false, label, lx: x1 + 8, ly, d: `M ${x1} ${y + ARROW_DY} H ${x2}` });
      bar(to, 0, 0, entry.after + 1, next?.after ?? sequence.calls.length, row, -1);
      return;
    }
    const call = r.call;
    open = open.filter((a) => a.end >= call.no);
    const fromLevel = Math.max(0, levelOn(from) - 1);
    const toLevel = levelOn(to);
    if (from === to) {
      const x1 = xs[from] + fromLevel * NEST + BAR / 2;
      const x2 = xs[to] + toLevel * NEST + BAR / 2;
      const out = x1 + LOOP;
      messages.push({
        call, to: r.to, row, y, x1, x2, self: true, label, lx: out + 6, ly: y + 4,
        d: `M ${x1} ${y - 6} H ${out} V ${y + ARROW_DY} H ${x2}`,
      });
    } else {
      const dir = xs[to] > xs[from] ? 1 : -1;
      const x1 = xs[from] + fromLevel * NEST + (dir * BAR) / 2;
      const x2 = xs[to] + toLevel * NEST - (dir * BAR) / 2;
      // in the middle of the arrow; on a long arrow near its start, where the call is made (the middle may be far away)
      const width = labelWidth(label);
      const long = Math.abs(x2 - x1) > width + LONG_ARROW;
      const lx = Math.round(long ? (dir > 0 ? x1 + 14 : x1 - 14 - width) : (x1 + x2) / 2 - width / 2);
      messages.push({ call, to: r.to, row, y, x1, x2, self: false, label, lx, ly, d: `M ${x1} ${y + ARROW_DY} H ${x2}` });
    }
    bar(to, toLevel, call.no, call.no, call.end, row, call.depth);
  });

  const rightmost = Math.max(0, ...lifelines.map((l, i) => l.x + Math.max(l.w / 2, right[i])));
  return {
    lifelines, messages, activations,
    width: Math.round(rightmost + 10),
    height: SEQUENCE_HEAD + rows.length * SEQUENCE_ROW + 12,
  };
}
