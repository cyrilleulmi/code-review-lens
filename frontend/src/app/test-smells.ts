import { TestSmell } from './api';

/**
 * Test-Smells: pure helpers for the test overview (chips, summary, filter), the header badge and the line chips of a
 * test's code block, and the tests tile of the overview.
 */

/** «keine Assertion» as chip text in the profile line and table. */
export function smellText(s: TestSmell): string {
  return s.label;
}

/** The badge in the header of a test: «Smell: keine Assertion», several joined by «, ». */
export function smellBadgeText(smells: TestSmell[]): string {
  return `Smell: ${smells.map((s) => s.label).join(', ')}`;
}

/** Tooltip of one smell: its hint, the line it shows at, and how it was found. */
export function smellDetail(s: TestSmell): string {
  const where = s.code ? `\n${s.line != null ? `Zeile ${s.line}: ` : ''}${s.code}` : '';
  return `${s.hint}${where}\n– Musterbasiert erkannt (Test-Smells)`;
}

/** Tooltip of the header badge: every smell with its hint. */
export function smellBadgeTitle(smells: TestSmell[]): string {
  return smells.map((s) => `${s.label}: ${s.hint}`).join('\n') + '\n– Musterbasiert erkannt (Test-Smells)';
}

/** «5 Tests mit Smells», «1 Test mit Smells» (the summary part and the tests tile); null when no test has one. */
export function smellsSummary(testsWithSmells: number): string | null {
  if (testsWithSmells <= 0) return null;
  return `${testsWithSmells} ${testsWithSmells === 1 ? 'Test' : 'Tests'} mit Smells`;
}

export function hasSmells(smells: TestSmell[] | undefined | null): boolean {
  return !!smells?.length;
}

/** How many of the tests have at least one smell. */
export function countWithSmells(tests: { smells?: TestSmell[] }[]): number {
  return tests.filter((t) => hasSmells(t.smells)).length;
}

/** The smells that show at a line (new-file line), by line; those without a line are left out. */
export function smellsByLine(smells: TestSmell[] | undefined | null): Map<number, TestSmell[]> {
  const result = new Map<number, TestSmell[]>();
  for (const s of smells ?? []) {
    if (s.line == null) continue;
    result.set(s.line, [...(result.get(s.line) ?? []), s]);
  }
  return result;
}
