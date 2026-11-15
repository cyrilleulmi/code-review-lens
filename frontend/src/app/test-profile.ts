import { AssertionKind, TestLevel, TestProfile, TestScenario } from './api';

/** Test-Steckbrief: labels, the one-line profile, the summary over all tests, filtering and sorting of the table. */

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
    { key: 'scenario', text: SCENARIO_LABELS[p.scenario], tip: scenarioTip(p) },
    { key: 'level', text: LEVEL_LABELS[p.level], tip: levelTip(p) },
    { key: 'assertions', text: assertionText(p), tip: assertionTip(p) },
  ];
  if (p.mocks.length) {
    parts.push({
      key: 'mocks',
      text: `Mocks: ${p.mocks.join(', ')}`,
      tip: `Ersetzte Abhängigkeiten – im Test, im Setup (beforeEach, Felder) oder in der umschliessenden Klasse/Suite: ${p.mocks.join(', ')}`
        + (p.mocks.includes('HTTP') ? '\nHTTP = Backend gemockt (HttpTestingController, MockWebServer, …)' : ''),
    });
  }
  if (p.parameterized) {
    parts.push({ key: 'cases', text: casesText(p), tip: casesTip(p) });
  }
  return parts;
}

export function scenarioTip(p: TestProfile): string {
  const what = {
    error: 'Fehlerfall: der Test erwartet einen Fehler (Exception, HTTP-Status ≥ 400, Fehlermeldung)',
    edge: 'Grenzfall: leere, null- oder Grenzwerte als Eingabe',
    normal: 'Normalfall: weder Fehler- noch Grenzfall erkannt',
  }[p.scenario];
  return what + reasonText(p.scenarioBy === 'name' ? 'am Testnamen' : 'im Code', p.scenarioBy ? p.scenarioReason : null);
}

export function levelTip(p: TestProfile): string {
  if (p.level === 'unit') {
    return 'Unit: kein Hinweis auf Integration oder E2E (Annotation, Testcontainers, echte HTTP-Aufrufe, Pfad)';
  }
  return LEVEL_LABELS[p.level] + reasonText(p.levelBy === 'path' ? 'am Pfad' : 'im Code', p.levelReason);
}

function reasonText(where: string, reason: string | null): string {
  return reason ? ` – erkannt ${where}: «${reason}»` : '';
}

/** Kinds with their count, most frequent first (fixed order among equals). */
export function assertionKinds(p: TestProfile): { kind: AssertionKind; n: number }[] {
  return KIND_ORDER.filter((k) => p.assertionKinds[k])
    .map((kind) => ({ kind, n: p.assertionKinds[kind]! }))
    .sort((a, b) => b.n - a.n);
}

/** «3 Assertions (Gleichheit, HTTP)», «1 Assertion (Interaktion)», «keine Assertion». */
export function assertionText(p: TestProfile): string {
  if (!p.assertions) return 'keine Assertion';
  const kinds = assertionKinds(p).map((k) => ASSERTION_LABELS[k.kind]);
  return `${p.assertions} ${p.assertions === 1 ? 'Assertion' : 'Assertions'}` + (kinds.length ? ` (${kinds.join(', ')})` : '');
}

function assertionTip(p: TestProfile): string {
  if (!p.assertions) {
    return 'Keine Assertion im Testrumpf erkannt – geprüft wird höchstens in Hilfsfunktionen, oder der Test prüft nichts';
  }
  return `Assertions im Testrumpf: ${assertionKinds(p).map((k) => `${k.n}× ${ASSERTION_LABELS[k.kind]}`).join(', ')}`;
}

/** «4 Fälle», «1 Fall», «parametrisiert» (number unknown). */
export function casesText(p: TestProfile): string {
  if (!p.parameterized) return '';
  if (p.cases == null) return 'parametrisiert';
  return p.cases === 1 ? '1 Fall' : `${p.cases} Fälle`;
}

function casesTip(p: TestProfile): string {
  const source = p.casesSource ? ` aus ${p.casesSource}` : '';
  return p.cases == null
    ? `Parametrisiert${source} – die Anzahl Fälle ist statisch nicht bestimmbar`
    : `Parametrisiert: läuft ${p.cases}× mit verschiedenen Werten${source}`;
}

// ------------------------------------------------------------------ summary and filter

/** A filter of the table, set by clicking a part of the summary. */
export type ProfileFilter =
  | { kind: 'scenario'; value: TestScenario }
  | { kind: 'level'; value: TestLevel }
  | { kind: 'parameterized' };

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
 * counts per scenario and level (most first, zeros left out) and the parameterised tests with their known cases.
 */
export function profileSummary(profiles: TestProfile[]): ProfileSummary {
  const count = <T extends string>(order: T[], of: (p: TestProfile) => T) =>
    order
      .map((value) => ({ value, n: profiles.filter((p) => of(p) === value).length }))
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n);
  const groups: SummaryPart[][] = [
    count(SCENARIO_ORDER, (p) => p.scenario).map((c) => ({ text: `${c.n} ${SCENARIO_LABELS[c.value]}`, filter: { kind: 'scenario', value: c.value } })),
    count(LEVEL_ORDER, (p) => p.level).map((c) => ({ text: `${c.n} ${LEVEL_LABELS[c.value]}`, filter: { kind: 'level', value: c.value } })),
  ];
  const parameterized = profiles.filter((p) => p.parameterized);
  if (parameterized.length) {
    const known = parameterized.filter((p) => p.cases != null);
    const cases = known.reduce((sum, p) => sum + p.cases!, 0);
    const casesPart = !known.length ? '' : ` (${known.length < parameterized.length ? 'mind. ' : ''}${cases} ${cases === 1 ? 'Fall' : 'Fälle'})`;
    groups.push([{ text: `${parameterized.length} parametrisiert${casesPart}`, filter: { kind: 'parameterized' } }]);
  }
  return { total: profiles.length, groups: groups.filter((g) => g.length) };
}

export function matchesFilter(p: TestProfile, f: ProfileFilter | null): boolean {
  if (!f) return true;
  switch (f.kind) {
    case 'scenario':
      return p.scenario === f.value;
    case 'level':
      return p.level === f.value;
    case 'parameterized':
      return p.parameterized;
  }
}

export function sameFilter(a: ProfileFilter | null, b: ProfileFilter | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && (a.kind === 'parameterized' || a.value === (b as { value: string }).value);
}

// ------------------------------------------------------------------ table

/** A row of the table: the test name and its profile. */
export interface ProfileRow {
  id: string;
  name: string;
  profile: TestProfile;
}

export type ProfileColumn = 'name' | 'targets' | 'scenario' | 'level' | 'assertions' | 'mocks' | 'cases';
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
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'de');
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((e) => e.r);
}

/** Clicking a header: a new column sorts ascending, the same column toggles the direction. */
export function nextSort(current: ProfileSort | null, column: ProfileColumn): ProfileSort {
  return current?.column === column ? { column, desc: !current.desc } : { column, desc: false };
}
