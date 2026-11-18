/**
 * Side-by-side view of a diff: which lines of a block stand next to each other. Old code (context + deleted lines)
 * is on the left, new code (context + added lines) on the right.
 */

/** Indices into the list of lines; null = that side is empty in this row. A context line or gap is on both sides. */
export interface LinePair {
  left: number | null;
  right: number | null;
}

/**
 * Pairs the lines of a unified diff for the side-by-side view. Within a run of changed lines the n-th deleted line
 * stands next to the n-th added one (like GitHub's split view); what is left over has an empty other side. Context
 * lines and gaps end a run and take both sides.
 */
export function pairLines(lines: readonly { type: string }[]): LinePair[] {
  const result: LinePair[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    for (let n = 0; n < Math.max(dels.length, adds.length); n++) {
      result.push({ left: dels[n] ?? null, right: adds[n] ?? null });
    }
    dels = [];
    adds = [];
  };
  lines.forEach((line, i) => {
    if (line.type === 'del') {
      dels.push(i);
    } else if (line.type === 'add') {
      adds.push(i);
    } else {
      flush();
      result.push({ left: i, right: i });
    }
  });
  flush();
  return result;
}

/** A line of a block; gaps bring the lines they hide. */
interface SideLine {
  type: string;
  hidden?: readonly SideLine[] | null;
}

/**
 * What a block has to put side by side: 'both' = removed and added lines, so old and new differ on both sides;
 * 'new' = only added lines, 'old' = only removed lines, 'none' = no changed line. Without lines on both sides one
 * half would only repeat the unchanged lines of the other with holes in between, so such a block stays in one column.
 */
export function diffSides(lines: readonly SideLine[]): 'both' | 'new' | 'old' | 'none' {
  let removed = false;
  let added = false;
  const walk = (list: readonly SideLine[]) => {
    for (const line of list) {
      removed ||= line.type === 'del';
      added ||= line.type === 'add';
      if (line.hidden?.length) walk(line.hidden);
    }
  };
  walk(lines);
  return removed && added ? 'both' : removed ? 'old' : added ? 'new' : 'none';
}
