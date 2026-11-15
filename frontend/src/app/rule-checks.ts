import { RuleCheck } from './api';

/**
 * Erwartungs-Regeln: pure helpers for the rules box of the tests view, the line chips of code blocks and the overview.
 * A check is «unmet» when no test that counts shows what the rule expects.
 */

/** Unmet checks first, each part in analysis order (by segment and line). */
export function sortChecks(checks: RuleCheck[]): RuleCheck[] {
  return [...checks.filter((c) => !c.met), ...checks.filter((c) => c.met)];
}

export function unmetCount(checks: RuleCheck[]): number {
  return checks.filter((c) => !c.met).length;
}

/** «2 von 4 Regeln nicht erfüllt», «Alle 3 Regeln erfüllt», «1 Regel erfüllt»; null without checks. */
export function rulesSummary(checks: RuleCheck[]): string | null {
  const total = checks.length;
  if (total === 0) return null;
  const unmet = unmetCount(checks);
  if (unmet === 0) return total === 1 ? '1 Regel erfüllt' : `Alle ${total} Regeln erfüllt`;
  return `${unmet} von ${total} ${total === 1 ? 'Regel' : 'Regeln'} nicht erfüllt`;
}

/** The overview: «2 Erwartungs-Regeln nicht erfüllt»; null when every check is met (or there is none). */
export function unmetWarning(checks: RuleCheck[]): string | null {
  const n = unmetCount(checks);
  if (n === 0) return null;
  return `${n} ${n === 1 ? 'Erwartungs-Regel' : 'Erwartungs-Regeln'} nicht erfüllt`;
}

/** The chip on the trigger line of an unmet check: «Regel: Test für den verweigerten Zugriff (401/403) fehlt». */
export function ruleChipText(c: RuleCheck): string {
  return `Regel: ${c.hint || c.label}`;
}

/** What a check means in full (tooltip, second line); testName resolves test ids. */
export function ruleDetail(c: RuleCheck, testName: (id: string) => string): string {
  const trigger = c.trigger ? ` (ausgelöst durch ${c.trigger})` : '';
  if (c.met) {
    return `${c.label}${trigger} – erfüllt durch ${c.metBy.map(testName).join(', ')}`;
  }
  const tests = c.tests.length
    ? `geprüft: ${c.tests.map(testName).join(', ')} – keiner zeigt das`
    : 'kein Test erreicht den Code';
  return `${c.label}${trigger} – ${c.hint || 'kein passender Test'}; ${tests}`;
}

/** Unmet checks of one segment by trigger line (for the line chips of a code block). */
export function unmetByLine(checks: RuleCheck[], segmentId: string): Map<number, RuleCheck[]> {
  const result = new Map<number, RuleCheck[]>();
  for (const c of checks) {
    if (c.met || c.segmentId !== segmentId || c.line == null) continue;
    result.set(c.line, [...(result.get(c.line) ?? []), c]);
  }
  return result;
}
