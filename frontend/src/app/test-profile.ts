import { AssertionKind, TestLevel, TestProfile, TestScenario, TestSmell } from './api';
import { smellsSummary } from './test-smells';
import { locale, t } from './i18n';

/** Test-Steckbrief: labels, the one-line profile, the summary over all tests, filtering and sorting of the table. */

/** Labels in German, translated with t(). */
export const SCENARIO_LABELS: Record<TestScenario, string> = { error: 'Fehlerfall', edge: 'Grenzfall', normal: 'Normalfall' };
export const LEVEL_LABELS: Record<TestLevel, string> = { unit: 'Unit', integration: 'Integration', e2e: 'E2E' };
export const ASSERTION_LABELS: Record<AssertionKind, string> = {
  equality: 'Gleichheit',
  exception: 'Exception',
  interaction: 'Interaktion',
  existence: 'Existenz',
  http: 'HTTP',
  snapshot: 'Snapshot',
  other: 'sonstige',
};

const SCENARIO_ORDER: TestScenario[] = ['error', 'edge', 'normal'];
const LEVEL_ORDER: TestLevel[] = ['unit', 'integration', 'e2e'];
const KIND_ORDER: AssertionKind[] = ['equality', 'exception', 'interaction', 'existence', 'http', 'snapshot', 'other'];

/** One part of the profile line with its explanation (tooltip). */
export interface ProfilePart {
  key: 'scenario' | 'level' | 'assertions' | 'mocks' | 'cases';
  text: string;
  tip: string;
}

/** «Fehlerfall · Integration · 3 Assertions (Gleichheit, HTTP) · Mocks: PlayerRepository, HTTP · 4 Fälle» as parts. */
export function profileParts(p: TestProfile): ProfilePart[] {
  const parts: ProfilePart[] = [
    { key: 'scenario', text: t(SCENARIO_LABELS[p.scenario]), tip: scenarioTip(p) },
    { key: 'level', text: t(LEVEL_LABELS[p.level]), tip: levelTip(p) },
    { key: 'assertions', text: assertionText(p), tip: assertionTip(p) },
  ];
  if (p.mocks.length) {
    parts.push({
      key: 'mocks',
      text: `Mocks: ${p.mocks.join(', ')}`,
      tip: t('Ersetzte Abhängigkeiten – im Test, im Setup (beforeEach, Felder) oder in der umschliessenden Klasse/Suite: {mocks}', { mocks: p.mocks.join(', ') })
        + (p.mocks.includes('HTTP') ? '\n' + t('HTTP = Backend gemockt (HttpTestingController, MockWebServer, …)') : ''),
    });
  }
  if (p.parameterized) {
    parts.push({ key: 'cases', text: casesText(p), tip: casesTip(p) });
  }
  return parts;
}

export function scenarioTip(p: TestProfile): string {
  const what = {
    error: t('Fehlerfall: der Test erwartet einen Fehler (Exception, HTTP-Status ≥ 400, Fehlermeldung)'),
    edge: t('Grenzfall: leere, null- oder Grenzwerte als Eingabe'),
    normal: t('Normalfall: weder Fehler- noch Grenzfall erkannt'),
  }[p.scenario];
  return what + reasonText(p.scenarioBy === 'name' ? t('am Testnamen') : t('im Code'), p.scenarioBy ? p.scenarioReason : null);
}

export function levelTip(p: TestProfile): string {
  if (p.level === 'unit') {
    return t('Unit: kein Hinweis auf Integration oder E2E (Annotation, Testcontainers, echte HTTP-Aufrufe, Pfad)');
  }
  return t(LEVEL_LABELS[p.level]) + reasonText(p.levelBy === 'path' ? t('am Pfad') : t('im Code'), p.levelReason);
}

function reasonText(where: string, reason: string | null): string {
  return reason ? t(' – erkannt {where}: «{reason}»', { where, reason }) : '';
}

/** Kinds with their count, most frequent first (fixed order among equals). */
export function assertionKinds(p: TestProfile): { kind: AssertionKind; n: number }[] {
  return KIND_ORDER.filter((k) => p.assertionKinds[k])
    .map((kind) => ({ kind, n: p.assertionKinds[kind]! }))
    .sort((a, b) => b.n - a.n);
}

/** «3 Assertions (Gleichheit, HTTP)», «1 Assertion (Interaktion)», «keine Assertion». */
export function assertionText(p: TestProfile): string {
  if (!p.assertions) return t('keine Assertion');
  const kinds = assertionKinds(p).map((k) => t(ASSERTION_LABELS[k.kind]));
  return t(p.assertions === 1 ? '{n} Assertion' : '{n} Assertions', { n: p.assertions }) + (kinds.length ? ` (${kinds.join(', ')})` : '');
}

function assertionTip(p: TestProfile): string {
  if (!p.assertions) {
    return t('Keine Assertion im Testrumpf erkannt – geprüft wird höchstens in Hilfsfunktionen, oder der Test prüft nichts');
  }
  return t('Assertions im Testrumpf: {kinds}', { kinds: assertionKinds(p).map((k) => `${k.n}× ${t(ASSERTION_LABELS[k.kind])}`).join(', ') });
}

/** «4 Fälle», «1 Fall», «parametrisiert» (number unknown). */
export function casesText(p: TestProfile): string {
  if (!p.parameterized) return '';
  if (p.cases == null) return t('parametrisiert');
  return t(p.cases === 1 ? '{n} Fall' : '{n} Fälle', { n: p.cases });
}

function casesTip(p: TestProfile): string {
  const source = p.casesSource ? t(' aus {source}', { source: p.casesSource }) : '';
  return p.cases == null
    ? t('Parametrisiert{source} – die Anzahl Fälle ist statisch nicht bestimmbar', { source })
    : t('Parametrisiert: läuft {n}× mit verschiedenen Werten{source}', { n: p.cases, source });
}

// ------------------------------------------------------------------ summary and filter

/** A filter of the table, set by clicking a part of the summary. */
export type ProfileFilter =
  | { kind: 'scenario'; value: TestScenario }
  | { kind: 'level'; value: TestLevel }
  | { kind: 'parameterized' }
  | { kind: 'smells' };

export interface SummaryPart {
  text: string;
  filter: ProfileFilter;
}

/** One group of the summary line («9 Normalfall, 4 Fehlerfall, 1 Grenzfall»); groups are separated by «·». */
export interface ProfileSummary {
  total: number;
  groups: SummaryPart[][];
}

/**
 * «14 Tests · 9 Normalfall, 4 Fehlerfall, 1 Grenzfall · 11 Unit, 3 Integration · 2 parametrisiert (9 Fälle)»:
 * counts per scenario and level (most first, zeros left out) and the parameterised tests with their known cases;
 * smelly: how many tests have Test-Smells, shown as a last part «5 Tests mit Smells» (none when 0).
 */
export function profileSummary(profiles: TestProfile[], smelly = 0): ProfileSummary {
  const count = <T extends string>(order: T[], of: (p: TestProfile) => T) =>
    order
      .map((value) => ({ value, n: profiles.filter((p) => of(p) === value).length }))
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n);
  const groups: SummaryPart[][] = [
    count(SCENARIO_ORDER, (p) => p.scenario).map((c) => ({ text: `${c.n} ${t(SCENARIO_LABELS[c.value])}`, filter: { kind: 'scenario', value: c.value } })),
    count(LEVEL_ORDER, (p) => p.level).map((c) => ({ text: `${c.n} ${t(LEVEL_LABELS[c.value])}`, filter: { kind: 'level', value: c.value } })),
  ];
  const parameterized = profiles.filter((p) => p.parameterized);
  if (parameterized.length) {
    const known = parameterized.filter((p) => p.cases != null);
    const cases = known.reduce((sum, p) => sum + p.cases!, 0);
    const casesPart = !known.length ? '' : ` (${known.length < parameterized.length ? t('mind.') + ' ' : ''}${t(cases === 1 ? '{n} Fall' : '{n} Fälle', { n: cases })})`;
    groups.push([{ text: t('{n} parametrisiert', { n: parameterized.length }) + casesPart, filter: { kind: 'parameterized' } }]);
  }
  const smells = smellsSummary(smelly);
  if (smells) {
    groups.push([{ text: smells, filter: { kind: 'smells' } }]);
  }
  return { total: profiles.length, groups: groups.filter((g) => g.length) };
}

/** smells: the Test-Smells of the test (for the filter «Tests mit Smells»). */
export function matchesFilter(p: TestProfile, f: ProfileFilter | null, smells: TestSmell[] = []): boolean {
  if (!f) return true;
  switch (f.kind) {
    case 'scenario':
      return p.scenario === f.value;
    case 'level':
      return p.level === f.value;
    case 'parameterized':
      return p.parameterized;
    case 'smells':
      return smells.length > 0;
  }
}

export function sameFilter(a: ProfileFilter | null, b: ProfileFilter | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && (a.kind === 'parameterized' || a.kind === 'smells' || a.value === (b as { value: string }).value);
}

// ------------------------------------------------------------------ table

/** A row of the table: the test name and its profile. */
export interface ProfileRow {
  id: string;
  name: string;
  profile: TestProfile;
  /** Test-Smells of the test (absent: none) */
  smells?: TestSmell[];
}

export type ProfileColumn = 'name' | 'targets' | 'scenario' | 'level' | 'assertions' | 'mocks' | 'cases' | 'smells';
export interface ProfileSort {
  column: ProfileColumn;
  desc: boolean;
}

/** Sort key of a column: scenarios error → edge → normal, levels unit → integration → e2e, counts numerically. */
function key(r: ProfileRow, column: ProfileColumn): string | number {
  const p = r.profile;
  switch (column) {
    case 'name':
      return r.name.toLowerCase();
    case 'targets':
      return p.targets.join(', ').toLowerCase();
    case 'scenario':
      return SCENARIO_ORDER.indexOf(p.scenario);
    case 'level':
      return LEVEL_ORDER.indexOf(p.level);
    case 'assertions':
      return p.assertions;
    case 'mocks':
      return p.mocks.length;
    case 'cases':
      // not parameterised < unknown number < known numbers
      return !p.parameterized ? -2 : p.cases ?? -1;
    case 'smells':
      return r.smells?.length ?? 0;
  }
}

/** Rows sorted by a column (stable: equal rows keep their order); no sort = as given. */
export function sortRows(rows: ProfileRow[], sort: ProfileSort | null): ProfileRow[] {
  if (!sort) return rows;
  const sign = sort.desc ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = key(a.r, sort.column);
      const y = key(b.r, sort.column);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), locale())
;
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((e) => e.r);
}

/** Clicking a header: a new column sorts ascending, the same column toggles the direction. */
export function nextSort(current: ProfileSort | null, column: ProfileColumn): ProfileSort {
  return current?.column === column ? { column, desc: !current.desc } : { column, desc: false };
}
