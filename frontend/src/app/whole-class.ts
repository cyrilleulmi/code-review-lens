import { DisplayLine, Segment } from './api';
import { flattenLines } from './highlight';

/**
 * Code view "Ganze Klassen" of a data flow: a file of a class as one block - every line of the file, changed or
 * not, with the steps of the flow (its methods) put in place. The lines of the file come from the backend
 * (FileView.whole) and carry the same keys as the display lines of the segments.
 */
export interface WholeBlock {
  /** the block as a segment for the code block: all lines of the file; own = a changed line of one of the steps */
  segment: Segment;
  /** ids of the steps (segments) in the block, in file order */
  parts: string[];
  /** line key -> id of the step the line belongs to (a call on it takes the colour of that step's connection) */
  owners: ReadonlyMap<string, string>;
  /** line (new file) a step starts at -> id of the step */
  starts: ReadonlyMap<number, string>;
}

/** Id of the block of a file; no segment of the analysis has such an id. */
export function wholeId(path: string): string {
  return 'whole:' + path;
}

/** The line (new file) a step starts at: where its symbol begins, else its first line with a number. */
export function startOf(step: Segment): number | null {
  return step.startLine ?? flattenLines(step.lines).find((f) => f.line.type !== 'gap' && f.line.newLine != null)?.line.newLine ?? null;
}

/**
 * Puts the steps into the lines of their file. A line of a step keeps what the step knows about it - whether it is a
 * change of that step (own) and its calls into other changed code; every other line of the file is context, and a
 * change that belongs to no step of the flow is shown as somebody else's (not own: dimmed, cannot be marked here).
 */
export function wholeBlock(name: string, path: string, fileLines: readonly DisplayLine[], steps: readonly Segment[]): WholeBlock {
  const known = new Map<string, { line: DisplayLine; owner: string }>();
  for (const step of steps) {
    for (const { line } of flattenLines(step.lines)) {
      if (line.type === 'gap' || !line.key) {
        continue;
      }
      const seen = known.get(line.key);
      // a line inside two steps (a function in a function) belongs to the one that changed it
      if (!seen || (line.own && !seen.line.own)) {
        known.set(line.key, { line, owner: step.id });
      }
    }
  }
  const owners = new Map<string, string>();
  const lines = fileLines.map((line): DisplayLine => {
    const hit = line.key ? known.get(line.key) : undefined;
    if (!hit) {
      return { ...line, own: false, refs: null, hidden: null };
    }
    owners.set(line.key!, hit.owner);
    return { ...line, own: hit.line.own, refs: hit.line.refs, hidden: null };
  });
  const ordered = steps.map((step) => ({ step, start: startOf(step) }))
    .sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  const starts = new Map<number, string>();
  for (const { step, start } of ordered) {
    if (start != null && !starts.has(start)) {
      starts.set(start, step.id);
    }
  }
  const first = ordered[0]?.step;
  return {
    segment: {
      id: wholeId(path), path, language: first?.language ?? '', kind: 'module', symbol: name, symbolKind: 'class',
      startLine: null, endLine: null, category: first?.category ?? '', group: '', ruleId: null, reason: '',
      lineKeys: [...new Set(steps.flatMap((s) => s.lineKeys))], lines, places: [], testedBy: [],
      layer: first?.layer ?? null, frontend: first?.frontend ?? false,
    },
    parts: ordered.map((o) => o.step.id),
    owners,
    starts,
  };
}
