/**
 * Layout of the sequence diagram of a data flow (flow-sequence.ts): a lifeline per class in the order they are first
 * called, a row per call from top to bottom, and on the lifelines the bars that show how long a step runs. A call that
 * gives something back has a second row: its arrow back, after the last call made while it runs. Pure geometry -
 * sequence-diagram.ts draws it. The widths come from the texts: every label fits between the lifelines it connects.
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

/**
 * A row of the diagram: the arrow of a call; call null: the arrow from outside into an entry point; ret: the arrow
 * back from a call that gives something back, in the row after the last call made while it runs.
 */
export interface Message {
  call: SequenceCall | null;
  /** an arrow back: `call` returns to its caller, the label is what it gives back */
  ret: boolean;
  /** segment id of the step the arrow points at (for an arrow back: the caller) */
  to: string;
  /** index of the row, from 0 */
  row: number;
  /** top and height of the row: the row of an arrow back is lower (SEQUENCE_RETURN_ROW) */
  top: number;
  h: number;
  /** vertical centre of the row */
  y: number;
  /** start and end of the arrow */
  x1: number;
  x2: number;
  /** a call within the class: a loop on its lifeline */
  self: boolean;
  label: string;
  /** left end of the label (for a call its bubble with the number comes first, for an arrow back its mark) */
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

/** Height of the row of a call: the list of calls beside the diagram uses the same, so its rows line up with the arrows. */
export const SEQUENCE_ROW = 32;
/** Height of the row of an arrow back (what a call gives back). */
export const SEQUENCE_RETURN_ROW = 24;
/** Room above the first row: the heads of the lifelines. */
export const SEQUENCE_HEAD = 46;
/** Height of the head of a lifeline. */
export const SEQUENCE_HEAD_BOX = 30;
/** Width of the bubble with the number in front of a label. */
export const SEQUENCE_BUBBLE = 18;
/** Width of the mark in front of the label of an arrow back («↩»). */
export const SEQUENCE_RETURN_MARK = 16;

/** Width of a bar, and how far a bar of the same class inside another one stands to the right. */
const BAR = 10;
const NEST = 5;
/** How far the loop of a call within a class reaches out. */
const LOOP = 26;
/** Width of a character of the label font (11px code font) and the head font (12px). */
const LABEL_CHAR = 6.7;
const HEAD_CHAR = 7.3;
/** Air between a label and the lifelines beside it, and between two heads. */
const LABEL_AIR = 26;
const HEAD_GAP = 22;
/** An arrow with this much more room than its label needs is a long one: its label stands at its start. */
const LONG_ARROW = 220;
/** The arrow of a row runs a little below its centre, the label stands above it; the same for an arrow back. */
const ARROW_DY = 7;
const LABEL_DY = -3;
const RETURN_DY = 4;
const RETURN_LABEL_DY = -5;

/** Width of a label with its bubble. */
export function labelWidth(label: string): number {
  return SEQUENCE_BUBBLE + 5 + Math.ceil(label.length * LABEL_CHAR);
}

/** Width of the label of an arrow back, with its mark. */
export function returnWidth(label: string): number {
  return SEQUENCE_RETURN_MARK + Math.ceil(label.length * LABEL_CHAR);
}

interface Row {
  call: SequenceCall | null;
  ret: boolean;
  to: string;
  label: string;
}

/**
 * Places the sequence. participantOf: the class of a step; labelOf: the text of a row - what is called (call null:
 * the entry point itself); returnOf: what a call gives back (null: nothing, no arrow back).
 */
export function sequenceLayout(
  sequence: FlowSequence,
  participantOf: (segmentId: string) => Participant,
  labelOf: (segmentId: string, call: SequenceCall | null) => string,
  returnOf: (call: SequenceCall) => string | null = () => null,
): SequenceLayout {
  // the rows: every entry point, followed by its calls; a call that gives something back returns after the last call
  // made while it runs. lastRow: the row in which a step ends (its arrow back, or the last row of what it calls)
  const rows: Row[] = [];
  const lastRow = new Map<number, number>();
  const entryEnds: number[] = [];
  sequence.entries.forEach((entry, i) => {
    const until = sequence.entries[i + 1]?.after ?? sequence.calls.length;
    rows.push({ call: null, ret: false, to: entry.id, label: labelOf(entry.id, null) });
    const running: SequenceCall[] = [];
    const close = (before: number) => {
      while (running.length && running[running.length - 1].end < before) {
        const done = running.pop()!;
        const back = returnOf(done);
        if (back != null) {
          rows.push({ call: done, ret: true, to: done.from, label: back });
        }
        lastRow.set(done.no, rows.length - 1);
      }
    };
    sequence.calls.slice(entry.after, until).forEach((call) => {
      close(call.no);
      rows.push({ call, ret: false, to: call.to, label: labelOf(call.to, call) });
      running.push(call);
    });
    close(Number.MAX_SAFE_INTEGER);
    entryEnds.push(rows.length - 1);
  });
  const heights = rows.map((r) => (r.ret ? SEQUENCE_RETURN_ROW : SEQUENCE_ROW));
  const tops: number[] = [];
  heights.reduce((top, h) => (tops.push(top), top + h), SEQUENCE_HEAD);
  const yOf = (row: number) => tops[row] + heights[row] / 2;
  const bottomOf = (row: number) => tops[row] + heights[row];

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
  const ends = rows.map((r) => (r.ret
    ? { from: lifelineOf(r.call!.to), to: lifelineOf(r.call!.from) }
    : { from: r.call ? lifelineOf(r.call.from) : -1, to: lifelineOf(r.to) }));
  const widths = order.map((p) => Math.min(280, Math.max(96, Math.round(p.name.length * HEAD_CHAR) + 34)));
  const widthOf = (r: Row) => (r.ret ? returnWidth(r.label) : labelWidth(r.label));

  // room every label needs: between two lifelines, right of a lifeline (a loop), or left of it (an entry point)
  const between: { i: number; j: number; need: number }[] = [];
  const left = order.map(() => 0);
  const right = order.map(() => 0);
  rows.forEach((r, n) => {
    const { from, to } = ends[n];
    const need = widthOf(r) + LABEL_AIR;
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

  // the bars and arrows, row by row; `open` = the steps running, innermost last; `at` = the ends of the arrow of each call
  const activations: Activation[] = [];
  const messages: Message[] = [];
  const at = new Map<number, { x1: number; x2: number }>();
  let open: { line: number; level: number; end: number }[] = [];
  let entryNo = -1;
  const levelOn = (line: number) => open.filter((a) => a.line === line).length;
  const bar = (line: number, level: number, no: number, start: number, end: number, row: number, last: number, depth: number): void => {
    const y1 = yOf(row) + ARROW_DY - 4;
    // a step that gives something back ends with its arrow back; else a step inside another ends a little earlier,
    // so the ends of nested bars stay apart
    const y2 = rows[last].ret && rows[last].call?.no === no
      ? yOf(last) + RETURN_DY + 2
      : Math.max(y1 + 11, bottomOf(last) - 3 * Math.min(depth + 1, 3));
    activations.push({ key: order[line].key, no, start, end, row, x: xs[line] + level * NEST - BAR / 2, y1, y2 });
    open.push({ line, level, end });
  };
  rows.forEach((r, row) => {
    const y = yOf(row);
    const label = r.label;
    const { from, to } = ends[row];
    const width = widthOf(r);
    const base = (lx: number, ly: number) => ({ to: r.to, row, top: tops[row], h: heights[row], y, label, lx, ly, ret: r.ret });
    if (!r.call) {
      // an entry point: everything before it is over; the arrow comes from outside
      open = [];
      entryNo++;
      const entry = sequence.entries[entryNo];
      const next = sequence.entries[entryNo + 1];
      const x2 = xs[to] - BAR / 2;
      const x1 = Math.max(4, x2 - width - 18);
      messages.push({ ...base(x1 + 8, y + LABEL_DY), call: null, x1, x2, self: false, d: `M ${x1} ${y + ARROW_DY} H ${x2}` });
      bar(to, 0, 0, entry.after + 1, next?.after ?? sequence.calls.length, row, entryEnds[entryNo], -1);
      return;
    }
    const call = r.call;
    if (r.ret) {
      // back from the bar of the step called to that of its caller: the way the call went, the other way round
      const { x1: callX1, x2: callX2 } = at.get(call.no)!;
      const ay = y + RETURN_DY;
      if (from === to) {
        const out = Math.max(callX1, callX2) + LOOP;
        messages.push({ ...base(out + 6, ay + RETURN_LABEL_DY + 2), call, x1: callX2, x2: callX1, self: true,
          d: `M ${callX2} ${ay - 8} H ${out} V ${ay} H ${callX1}` });
      } else {
        const back = callX1 < callX2;
        const long = Math.abs(callX1 - callX2) > width + LONG_ARROW;
        // the label near the start of a long arrow back, where the value comes from
        const lx = Math.round(long ? (back ? callX2 - 14 - width : callX2 + 14) : (callX1 + callX2) / 2 - width / 2);
        messages.push({ ...base(lx, ay + RETURN_LABEL_DY), call, x1: callX2, x2: callX1, self: false, d: `M ${callX2} ${ay} H ${callX1}` });
      }
      return;
    }
    open = open.filter((a) => a.end >= call.no);
    const fromLevel = Math.max(0, levelOn(from) - 1);
    const toLevel = levelOn(to);
    if (from === to) {
      const x1 = xs[from] + fromLevel * NEST + BAR / 2;
      const x2 = xs[to] + toLevel * NEST + BAR / 2;
      const out = x1 + LOOP;
      at.set(call.no, { x1, x2 });
      messages.push({ ...base(out + 6, y + 4), call, x1, x2, self: true, d: `M ${x1} ${y - 6} H ${out} V ${y + ARROW_DY} H ${x2}` });
    } else {
      const dir = xs[to] > xs[from] ? 1 : -1;
      const x1 = xs[from] + fromLevel * NEST + (dir * BAR) / 2;
      const x2 = xs[to] + toLevel * NEST - (dir * BAR) / 2;
      // in the middle of the arrow; on a long arrow near its start, where the call is made (the middle may be far away)
      const long = Math.abs(x2 - x1) > width + LONG_ARROW;
      const lx = Math.round(long ? (dir > 0 ? x1 + 14 : x1 - 14 - width) : (x1 + x2) / 2 - width / 2);
      at.set(call.no, { x1, x2 });
      messages.push({ ...base(lx, y + LABEL_DY), call, x1, x2, self: false, d: `M ${x1} ${y + ARROW_DY} H ${x2}` });
    }
    bar(to, toLevel, call.no, call.no, call.end, row, lastRow.get(call.no) ?? row, call.depth);
  });

  const rightmost = Math.max(0, ...lifelines.map((l, i) => l.x + Math.max(l.w / 2, right[i])));
  return {
    lifelines, messages, activations,
    width: Math.round(rightmost + 10),
    height: (rows.length ? bottomOf(rows.length - 1) : SEQUENCE_HEAD) + 12,
  };
}
