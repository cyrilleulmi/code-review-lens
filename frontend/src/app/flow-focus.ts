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
