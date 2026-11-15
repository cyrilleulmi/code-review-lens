import { Analysis, EdgeCoverage, EdgeRunStatus, FlowCoverage, MockWarning, Segment, StepCoverage, StepRunStatus } from './api';

/**
 * Mock-Grenzen in words: which steps and calls of a flow the tests really execute, and which tests mock changed code
 * (Analysis.flowCoverage / mockWarnings). Pure helpers for the flow view, the tests view and the code blocks.
 */

export const STEP_LABELS: Record<StepRunStatus, string> = {
  tested: 'echt getestet',
  mocked: 'nur gemockt',
  none: 'nicht erreicht',
};

export const EDGE_LABELS: Record<EdgeRunStatus, string> = {
  tested: 'von einem Test durchlaufen',
  separate: 'nur einzeln getestet',
  partial: 'nur eine Seite getestet',
  none: 'nicht getestet',
};

/** Name of a test by id: changed tests by segment id, existing tests by "e1" …; the id when unknown. */
export function testNamer(analysis: Analysis | null | undefined): (id: string) => string {
  const names = new Map<string, string>();
  for (const t of analysis?.tests ?? []) names.set(t.segmentId, t.name);
  for (const t of analysis?.existingTests ?? []) names.set(t.id, t.name);
  return (id) => names.get(id) ?? id;
}

/** «a, b und 3 weitere»: the first names, the rest counted. */
export function nameList(names: string[], max = 3): string {
  if (names.length <= max) {
    return names.length > 1 ? names.slice(0, -1).join(', ') + ' und ' + names[names.length - 1] : names.join('');
  }
  return `${names.slice(0, max).join(', ')} und ${names.length - max} weitere`;
}

/** The coverage of one flow by segment id (steps) and by "from>to" (edges); empty maps when there is none. */
export function flowRuns(coverage: FlowCoverage | null | undefined): {
  steps: Map<string, StepCoverage>;
  edges: Map<string, EdgeCoverage>;
} {
  return {
    steps: new Map((coverage?.steps ?? []).map((s) => [s.segmentId, s])),
    edges: new Map((coverage?.edges ?? []).map((e) => [e.from + '>' + e.to, e])),
  };
}

/** Tooltip of a flow step: its status, the tests that run it for real, those that only mock it, and the warnings. */
export function stepTitle(step: StepCoverage | undefined, name: (id: string) => string, warnings: MockWarning[] = []): string {
  if (!step) return '';
  const lines = [`Tests: ${STEP_LABELS[step.status]}`];
  if (step.tests.length) lines.push(`echt ausgeführt von ${nameList(step.tests.map(name))}`);
  if (step.mockedBy.length) lines.push(`gemockt in ${nameList(step.mockedBy.map(name))}`);
  for (const w of warnings) lines.push(`⚠ ${w.testName} stubbt ${w.collaborator}.${w.member} – prüft das alte Verhalten`);
  return lines.join('\n');
}

/** Tooltip of a flow connection: its status and which tests cross it. */
export function edgeTitle(edge: EdgeCoverage | undefined, name: (id: string) => string): string {
  if (!edge) return '';
  switch (edge.status) {
    case 'tested':
      return `${EDGE_LABELS.tested}: ${nameList(edge.tests.map(name))}`;
    case 'separate':
      return `${EDGE_LABELS.separate}: beide Seiten haben Tests, aber kein Test läuft durch diesen Aufruf`;
    case 'partial':
      return `${EDGE_LABELS.partial}: kein Test läuft durch diesen Aufruf`;
    default:
      return `${EDGE_LABELS.none}: kein Test erreicht eine der beiden Seiten`;
  }
}

/** Mock warnings grouped by a key (the mocked segment, or the test). */
export function groupWarnings(warnings: MockWarning[] | null | undefined, by: 'segmentId' | 'test'): Map<string, MockWarning[]> {
  const map = new Map<string, MockWarning[]>();
  for (const w of warnings ?? []) {
    const list = map.get(w[by]) ?? [];
    list.push(w);
    map.set(w[by], list);
  }
  return map;
}

/**
 * The block that shows a line of a file: the innermost segment whose symbol spans it (a stub in the setup of a suite
 * belongs to the suite, not to the test), else the fallback (the test itself).
 */
export function lineOwner(segments: Iterable<Segment>, path: string, line: number | null, fallback: string): string {
  if (line == null) return fallback;
  let best: Segment | null = null;
  for (const s of segments) {
    if (s.path === path && s.startLine != null && s.endLine != null && s.startLine <= line && line <= s.endLine
      && (!best || s.endLine - s.startLine < best.endLine! - best.startLine!)) {
      best = s;
    }
  }
  return best?.id ?? fallback;
}

/** Header badge of a test that mocks changed code: the stubbed members in the tooltip. */
export function mockBadgeTitle(warnings: MockWarning[]): string {
  const members = [...new Set(warnings.map((w) => `${w.collaborator}.${w.member}`))];
  return `Dieser Test ersetzt geänderten Code durch einen Mock: ${members.join(', ')}`
    + ' – er prüft das alte Verhalten der Funktion, nicht das neue. Musterbasiert erkannt (Mock-Grenzen).';
}
