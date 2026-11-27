/**
 * Class level of a data flow: the steps (methods, functions) of a flow combined by the class they belong to - for
 * the diagram (one box per class, calls between classes) and for the code (one card per class).
 */

/** What the code of a data flow shows as one card: single methods / functions, or whole classes with their methods of the flow. */
export type FlowLevel = 'method' | 'class';
/** The diagram can also show both: classes as frames with their methods as smaller boxes inside. */
export type FlowDiagramLevel = FlowLevel | 'combined';

/**
 * The level the code of a flow takes when it follows the diagram: classes for the class diagram; methods otherwise -
 * also for the combined diagram, whose boxes are the methods.
 */
export function codeLevelFor(diagram: FlowDiagramLevel): FlowLevel {
  return diagram === 'class' ? 'class' : 'method';
}

/** The class a step belongs to. */
export interface ClassInfo {
  key: string;
  name: string;
}

/**
 * Class of a segment: its component (files with the same name in the same folder: a class, a module, an Angular
 * component with template and styles); without one, the file.
 */
export function classOf(seg: { path: string }, component: { id: string; name: string } | undefined): ClassInfo {
  if (component) {
    return { key: component.id, name: component.name };
  }
  const file = seg.path.substring(seg.path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return { key: dot > 0 ? seg.path.substring(0, seg.path.length - (file.length - dot)) : seg.path, name: dot > 0 ? file.substring(0, dot) : file };
}

/** "PlayerResource.update" for "api.PlayerResource.update": the last two parts of a symbol name; a plain name as it is. */
export function shortName(name: string): string {
  const parts = name.split('.');
  return parts.length > 1 && parts[parts.length - 1] ? parts.slice(-2).join('.') : name;
}

/** A step by name with its class, "PlayerResource.update"; without a symbol the name of its file; the id when it is unknown. */
export function stepName(seg: { symbol: string | null; path: string } | undefined, id: string): string {
  return seg ? shortName(seg.symbol ?? seg.path.substring(seg.path.lastIndexOf('/') + 1)) : id;
}

/** A step as the flow view shows it: its depth and the caller shown (null = a root). */
export interface ClassMember {
  step: { segmentId: string };
  depth: number;
  caller: string | null;
}

export interface ClassGroup<T> extends ClassInfo {
  /** the steps of the class in call order */
  members: T[];
  /** call depth of the class: one more than the class that calls it first */
  depth: number;
  /** key of that class; null = the class of an entry point */
  caller: string | null;
}

/**
 * Combines the steps of a flow by class, in the order the classes are first reached. A class is placed below the
 * class that calls into it first (the caller of its first step, skipping callers of the same class); later calls
 * back into a class already shown do not move it.
 */
export function groupByClass<T extends ClassMember>(nodes: readonly T[], classOfStep: (segmentId: string) => ClassInfo): ClassGroup<T>[] {
  const byId = new Map(nodes.map((n) => [n.step.segmentId, n]));
  const keyOf = (id: string) => classOfStep(id).key;
  const groups = new Map<string, ClassGroup<T>>();
  for (const node of nodes) {
    const info = classOfStep(node.step.segmentId);
    const group = groups.get(info.key);
    if (group) {
      group.members.push(node);
      continue;
    }
    // up the callers until one of another class
    let caller = node.caller;
    const seen = new Set<string>();
    while (caller && keyOf(caller) === info.key && !seen.has(caller)) {
      seen.add(caller);
      caller = byId.get(caller)?.caller ?? null;
    }
    const parent = caller && keyOf(caller) !== info.key ? groups.get(keyOf(caller)) : undefined;
    groups.set(info.key, { ...info, members: [node], depth: parent ? parent.depth + 1 : 0, caller: parent?.key ?? null });
  }
  return [...groups.values()];
}

export interface ClassRun<T> extends ClassInfo {
  /** consecutive steps of the class, in call order */
  members: T[];
  /** the smallest call depth among them */
  depth: number;
}

/**
 * The steps of a flow in call order, cut into runs of consecutive steps of the same class: what the method level of
 * the code shows together, so one sees which blocks belong to one class. A class called again later starts a new run.
 */
export function classRuns<T extends ClassMember>(nodes: readonly T[], classOfStep: (segmentId: string) => ClassInfo): ClassRun<T>[] {
  const runs: ClassRun<T>[] = [];
  for (const node of nodes) {
    const info = classOfStep(node.step.segmentId);
    const last = runs[runs.length - 1];
    if (last && last.key === info.key) {
      last.members.push(node);
      last.depth = Math.min(last.depth, node.depth);
    } else {
      runs.push({ ...info, members: [node], depth: node.depth });
    }
  }
  return runs;
}

export interface ClassLink<E> {
  /** class keys */
  from: string;
  to: string;
  /** the calls combined, in flow order */
  edges: E[];
}

/**
 * The calls between classes: the edges of a flow combined per pair of classes, in the order of the first call. Calls
 * within a class and edges with an end that is not shown (no class) are left out.
 */
export function classLinks<E extends { from: string; to: string }>(edges: readonly E[], keyOf: (segmentId: string) => string | undefined): ClassLink<E>[] {
  const links = new Map<string, ClassLink<E>>();
  for (const edge of edges) {
    const from = keyOf(edge.from);
    const to = keyOf(edge.to);
    if (from == null || to == null || from === to) {
      continue;
    }
    const id = from + '>' + to;
    const link = links.get(id) ?? { from, to, edges: [] };
    link.edges.push(edge);
    links.set(id, link);
  }
  return [...links.values()];
}

/** The steps of a class as they stand in the code: by file, then by line (steps without a line keep their order, last). */
export function inFileOrder<T extends { segment: { path: string; startLine: number | null } }>(members: readonly T[]): T[] {
  return members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.segment.path.localeCompare(b.m.segment.path)
      || (a.m.segment.startLine ?? Number.MAX_SAFE_INTEGER) - (b.m.segment.startLine ?? Number.MAX_SAFE_INTEGER)
      || a.i - b.i)
    .map((x) => x.m);
}

/**
 * The weakest of several statuses: a class counts as tested only when all its steps are, a connection between classes
 * only when all its calls are. `order` lists the statuses from weakest to strongest; null when there is none.
 */
export function weakest<S extends string>(statuses: readonly (S | null | undefined)[], order: readonly S[]): S | null {
  const present = statuses.filter((s): s is S => s != null);
  return order.find((s) => present.includes(s)) ?? null;
}

/** Steps outside the branches of several steps (focus on a class): what is outside every one of them. */
export function intersect(sets: readonly ReadonlySet<string>[]): Set<string> {
  const [first, ...rest] = sets;
  return new Set([...(first ?? [])].filter((id) => rest.every((s) => s.has(id))));
}

/**
 * The code of a flow can also be shown by line (the called block right after the line that calls it) and as whole
 * classes (every file of a class in one block, unchanged code included).
 */
export type FlowCodeLevel = FlowLevel | 'inline' | 'whole';

/** A block in the code by line: a step, placed after the line of its caller that calls it. */
export interface InlineStep {
  /** segment id of the step */
  id: string;
  /** unique in the tree: the way from the root to this place */
  key: string;
  /** line of the caller (new file) the block follows; null = no line known, it follows the caller's code */
  line: number | null;
  /** the blocks its own lines call */
  children: InlineStep[];
  /** not unfolded again: the step is shown further up already and the view would grow beyond its limit */
  cut: boolean;
}

/**
 * The steps of a flow as a tree by line: every block has the blocks it calls placed after the calling lines, so a
 * method is not read to its end before the called code comes. A step called from several lines is shown at each of
 * them. A call back into a step that is open further up the same branch is left out (it would never end), and once
 * `limit` blocks are placed a step shown before is not unfolded again (`cut`).
 *
 * steps: in flow order with the caller shown (null = an entry point); a step whose caller has no call with a line to
 * it (a caller across removed areas) follows the caller's code. edges: the calls with the calling line.
 */
export function inlineTree(
  steps: readonly { id: string; caller: string | null }[],
  edges: readonly { from: string; to: string; line: number | null }[],
  limit = 60,
): InlineStep[] {
  const shown = new Set(steps.map((s) => s.id));
  const calls = new Map<string, { to: string; line: number | null }[]>();
  const add = (from: string, to: string, line: number | null) => {
    const list = calls.get(from) ?? [];
    if (!list.some((c) => c.to === to && c.line === line)) {
      list.push({ to, line });
    }
    calls.set(from, list);
  };
  for (const e of edges) {
    if (shown.has(e.from) && shown.has(e.to) && e.from !== e.to) {
      add(e.from, e.to, e.line);
    }
  }
  for (const s of steps) {
    if (s.caller && !calls.get(s.caller)?.some((c) => c.to === s.id)) {
      add(s.caller, s.id, null);
    }
  }
  const placed = new Set<string>();
  let count = 0;
  const build = (id: string, line: number | null, path: readonly string[], prefix: string): InlineStep => {
    const key = `${prefix}/${id}@${line ?? ''}`;
    const cut = placed.has(id) && count >= limit;
    placed.add(id);
    count++;
    const below = [...path, id];
    const children = cut ? [] : [...(calls.get(id) ?? [])]
      .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER))
      .filter((c) => !below.includes(c.to))
      .map((c) => build(c.to, c.line, below, key));
    return { id, key, line, children, cut };
  };
  const roots = steps.filter((s) => !s.caller).map((s) => build(s.id, null, [], ''));
  // a step no entry point reaches (should not happen) still gets its place, at the end
  for (const s of steps) {
    if (!placed.has(s.id)) {
      roots.push(build(s.id, null, [], ''));
    }
  }
  return roots;
}
