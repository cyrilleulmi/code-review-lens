/**
 * Focus on a step of a flow: the steps outside its branch (the step plus everything it calls, directly or
 * further down). The view hides them like steps hidden one by one with the eye, so they stay in the diagram.
 */
export function outsideBranch(
  steps: readonly { segmentId: string }[],
  edges: readonly { from: string; to: string }[],
  root: string,
): Set<string> {
  const branch = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (branch.has(e.from) && !branch.has(e.to)) {
        branch.add(e.to);
        grew = true;
      }
    }
  }
  return new Set(steps.map((s) => s.segmentId).filter((id) => !branch.has(id)));
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** A step of a flow with its area (layer, '' = none). */
export interface AreaStep {
  step: { segmentId: string; depth: number; parentSegmentId: string | null };
  area: string;
}

/**
 * Takes the steps of removed areas out of a flow and bridges around them: each step left gets the nearest ancestor
 * that is left as its caller (null = it becomes a root), the areas skipped on the way (in order, once each) and a
 * depth reduced by the removed steps above it, so the diagram and the indentation close the gaps.
 */
export function withoutAreas<T extends AreaStep>(
  all: readonly T[],
  removed: ReadonlySet<string>,
): (T & { depth: number; caller: string | null; skipped: string[] })[] {
  const byId = new Map(all.map((s) => [s.step.segmentId, s]));
  const kept = all.filter((s) => !removed.has(s.area));
  const keptIds = new Set(kept.map((s) => s.step.segmentId));
  return kept.map((s) => {
    // up the whole chain: the first ancestor left is the caller, the removed ones before it are bridged, and every
    // removed ancestor (also above the caller) takes one level off the depth
    let caller: string | null = null;
    const skipped: string[] = [];
    let gone = 0;
    const seen = new Set<string>();
    for (let id = s.step.parentSegmentId ?? null; id && !seen.has(id); ) {
      seen.add(id);
      const parent = byId.get(id);
      if (!parent) {
        break;
      }
      if (keptIds.has(id)) {
        caller ??= id;
      } else {
        gone++;
        if (caller == null && !skipped.includes(parent.area)) skipped.push(parent.area);
      }
      id = parent.step.parentSegmentId ?? null;
    }
    return { ...s, depth: Math.max(0, s.step.depth - gone), caller, skipped };
  });
}
