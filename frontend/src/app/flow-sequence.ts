/**
 * Abfolge (call sequence) of a data flow: the calls of the flow one after the other, as they stand in the code. The
 * flow itself is a graph (every step once, an edge per caller and callee); the sequence walks it from the entry
 * point, every caller line by line, and lists each call when its line is reached - a step called from two lines is
 * called twice. It is what the list of calls, the sequence diagram and the playback in the diagrams show.
 *
 * Static like the flow: the order is the order of the calling lines, conditions and loops are not known.
 */

/** A call of the flow as the analysis delivers it (FlowEdge). */
export interface SequenceEdge {
  from: string;
  to: string;
  line: number | null;
  via: string;
  kind: 'call' | 'http';
  /** every line of the caller that calls the callee; missing in older analyses (then only `line` is known) */
  lines?: readonly number[] | null;
}

export interface SequenceCall {
  /** position in the sequence, from 1 */
  no: number;
  /** segment id of the caller: the step whose line calls, or - around steps left out - the nearest step shown above it */
  from: string;
  /** segment id of the step called */
  to: string;
  /** calling line (new file) in the caller's code; null = not known, or the call runs through steps left out */
  line: number | null;
  /** what the calling line names: the function, or for REST the request ("PUT /api/players/{}") */
  via: string;
  http: boolean;
  /** index of the edge of the flow (its colour); -1 never occurs for a call listed */
  edge: number;
  /** nesting: 0 = called by an entry point */
  depth: number;
  /** the call that is running while this one is made (its `no`); null = made by an entry point */
  parent: number | null;
  /** the last call made while the step called runs (its own `no` when it calls nothing, or is not unfolded) */
  end: number;
  /**
   * The step was unfolded before, at the call with this `no` (0 = it is an entry point): what it calls is listed
   * there and not again. null = this call unfolds it.
   */
  repeatOf: number | null;
  /** a call back into a step that is still running (recursion, a cycle): not unfolded either */
  back: boolean;
  /** the call runs through steps that are left out */
  bridged: boolean;
}

export interface SequenceEntry {
  /** segment id of the entry point */
  id: string;
  /** number of calls listed before it starts: its own calls follow from `after + 1` */
  after: number;
}

export interface FlowSequence {
  /** where the sequence starts: the entry points of the flow (one, as a rule) */
  entries: SequenceEntry[];
  calls: SequenceCall[];
}

interface Site {
  edge: number;
  to: string;
  line: number | null;
  via: string;
  http: boolean;
}

/**
 * The calls of a flow in the order of the code. steps: in flow order with their caller (null = an entry point).
 * hidden: steps left out (removed areas) - what they call counts as called by the nearest step shown above them, and
 * a step shown below a hidden entry point starts the sequence itself.
 *
 * Every step is unfolded once, at its first call; later calls of it are listed without what follows from them
 * (`repeatOf`), so the sequence has at most one entry per calling line and never runs in circles.
 */
export function flowSequence(
  steps: readonly { segmentId: string; parentSegmentId: string | null }[],
  edges: readonly SequenceEdge[],
  hidden: ReadonlySet<string> = new Set(),
): FlowSequence {
  const known = new Set(steps.map((s) => s.segmentId));
  const sites = new Map<string, Site[]>();
  edges.forEach((e, edge) => {
    if (!known.has(e.from) || !known.has(e.to)) {
      return;
    }
    const lines = e.lines?.length ? e.lines : [e.line];
    const list = sites.get(e.from) ?? [];
    for (const line of new Set(lines)) {
      list.push({ edge, to: e.to, line, via: e.via, http: e.kind === 'http' });
    }
    sites.set(e.from, list);
  });
  // line by line; a call without a line comes first, as in the numbering of the steps
  sites.forEach((list) => list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.edge - b.edge));

  const entries: SequenceEntry[] = [];
  const calls: SequenceCall[] = [];
  /** steps unfolded so far -> the call that unfolded them (0 = an entry point) */
  const unfolded = new Map<string, number>();
  /** hidden steps walked so far: their calls are passed on once */
  const passed = new Set<string>();

  const start = (id: string, running: readonly string[]): void => {
    unfolded.set(id, 0);
    entries.push({ id, after: calls.length });
    walk(id, id, 0, null, [...running, id], false);
  };

  /** Lists the calls in the code of `id` as calls of `actor` (the step itself, or the step shown above a hidden one). */
  const walk = (id: string, actor: string | null, depth: number, parent: number | null, running: readonly string[], bridged: boolean): void => {
    for (const site of sites.get(id) ?? []) {
      if (hidden.has(site.to)) {
        if (!passed.has(site.to)) {
          passed.add(site.to);
          walk(site.to, actor, depth, parent, [...running, site.to], true);
        }
        continue;
      }
      if (actor == null) {
        // nothing shown above: the step starts the sequence (once)
        if (!unfolded.has(site.to)) {
          start(site.to, running);
        }
        continue;
      }
      const call: SequenceCall = {
        no: calls.length + 1, from: actor, to: site.to, line: bridged ? null : site.line, via: site.via, http: site.http, edge: site.edge,
        depth, parent, end: 0, repeatOf: null, back: running.includes(site.to), bridged,
      };
      calls.push(call);
      if (!call.back) {
        const before = unfolded.get(site.to);
        if (before != null) {
          call.repeatOf = before;
        } else {
          unfolded.set(site.to, call.no);
          walk(site.to, site.to, depth + 1, call.no, [...running, site.to], false);
        }
      }
      call.end = calls.length;
    }
  };

  for (const step of steps) {
    if (step.parentSegmentId != null || unfolded.has(step.segmentId) || passed.has(step.segmentId)) {
      continue;
    }
    if (hidden.has(step.segmentId)) {
      passed.add(step.segmentId);
      walk(step.segmentId, null, 0, null, [step.segmentId], true);
    } else {
      start(step.segmentId, []);
    }
  }
  return { entries, calls };
}

/** Kinds of symbols that are used, not called: a step of such a kind is no call of the sequence when only calls are wanted. */
const USED_KINDS = new Set(['const', 'type', 'interface', 'enum']);

/** A step that is used rather than called: a constant or a type (by the kind of its symbol). */
export function isUsedNotCalled(symbolKind: string | null | undefined): boolean {
  return symbolKind != null && USED_KINDS.has(symbolKind);
}

/**
 * What a sequence consists of, as a text: equal for two sequences with the same entry points and calls - to tell
 * whether a sequence that was computed again (new data, the same flow) is still the one being played.
 */
export function sequenceKey(sequence: FlowSequence): string {
  return sequence.entries.map((e) => `${e.id}@${e.after}`).join(',') + '|' + sequence.calls.map((c) => `${c.from}>${c.to}@${c.line ?? ''}`).join(',');
}

/** The calls running at call `no`, from the outermost to the call itself (the call stack); empty for 0 or an unknown call. */
export function callStack(calls: readonly SequenceCall[], no: number): SequenceCall[] {
  const stack: SequenceCall[] = [];
  let call: SequenceCall | undefined = calls[no - 1];
  while (call) {
    stack.unshift(call);
    call = call.parent == null ? undefined : calls[call.parent - 1];
  }
  return stack;
}

/** The entry point a call belongs to: the last one that started before it. */
export function entryOf(sequence: FlowSequence, no: number): SequenceEntry | null {
  let found: SequenceEntry | null = null;
  for (const entry of sequence.entries) {
    if (entry.after < no) {
      found = entry;
    }
  }
  return found;
}
