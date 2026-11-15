import { RuleCheck } from './api';
import { serverText, t } from './i18n';

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
  if (unmet === 0) return total === 1 ? t('1 Regel erfüllt') : t('Alle {n} Regeln erfüllt', { n: total });
  return t(total === 1 ? '{unmet} von {total} Regel nicht erfüllt' : '{unmet} von {total} Regeln nicht erfüllt', { unmet, total });
}

/** The overview: «2 Erwartungs-Regeln nicht erfüllt»; null when every check is met (or there is none). */
export function unmetWarning(checks: RuleCheck[]): string | null {
  const n = unmetCount(checks);
  if (n === 0) return null;
  return t(n === 1 ? '{n} Erwartungs-Regel nicht erfüllt' : '{n} Erwartungs-Regeln nicht erfüllt', { n });
}

/** The chip on the trigger line of an unmet check: «Regel: Test für den verweigerten Zugriff (401/403) fehlt». */
export function ruleChipText(c: RuleCheck): string {
  return t('Regel: {text}', { text: serverText(c.hint || c.label) });
}

/** What a check means in full (tooltip, second line); testName resolves test ids. */
export function ruleDetail(c: RuleCheck, testName: (id: string) => string): string {
  const label = serverText(c.label);
  const trigger = c.trigger ? t(' (ausgelöst durch {trigger})', { trigger: serverText(c.trigger) }) : '';
  if (c.met) {
    return t('{label}{trigger} – erfüllt durch {tests}', { label, trigger, tests: c.metBy.map(testName).join(', ') });
  }
  const tests = c.tests.length
    ? t('geprüft: {tests} – keiner zeigt das', { tests: c.tests.map(testName).join(', ') })
    : t('kein Test erreicht den Code');
  return `${label}${trigger} – ${c.hint ? serverText(c.hint) : t('kein passender Test')}; ${tests}`;
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
