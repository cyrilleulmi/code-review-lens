import { describe, expect, it } from 'vitest';
import { TestProfile } from './api';
import { ProfileRow, assertionText, casesText, matchesFilter, nextSort, profileParts, profileSummary, sortRows } from './test-profile';

function profile(partial: Partial<TestProfile>): TestProfile {
  return {
    targets: [], scenario: 'normal', scenarioBy: null, scenarioReason: null, assertions: 1, assertionKinds: { equality: 1 },
    mocks: [], level: 'unit', levelBy: null, levelReason: null, parameterized: false, cases: null, casesSource: null, ...partial,
  };
}

describe('test profile (Test-Steckbrief)', () => {
  it('builds the one-line profile with explanations', () => {
    const p = profile({
      scenario: 'error', scenarioBy: 'code', scenarioReason: '.statusCode(404',
      level: 'integration', levelBy: 'code', levelReason: '@QuarkusTest',
      assertions: 3, assertionKinds: { http: 1, equality: 2 },
      mocks: ['PlayerRepository', 'HTTP'], parameterized: true, cases: 4, casesSource: '@CsvSource',
    });
    const parts = profileParts(p);
    expect(parts.map((x) => x.text).join(' · '))
      .toBe('Fehlerfall · Integration · 3 Assertions (Gleichheit, HTTP) · Mocks: PlayerRepository, HTTP · 4 Fälle');
    expect(parts[0].tip).toContain('erkannt im Code: «.statusCode(404»');
    expect(parts[1].tip).toBe('Integration – erkannt im Code: «@QuarkusTest»');
    expect(parts[4].tip).toContain('@CsvSource');
  });

  it('leaves out mocks and cases when there are none and says when nothing is asserted', () => {
    const parts = profileParts(profile({ assertions: 0, assertionKinds: {} }));
    expect(parts.map((x) => x.key)).toEqual(['scenario', 'level', 'assertions']);
    expect(assertionText(profile({ assertions: 0, assertionKinds: {} }))).toBe('keine Assertion');
    expect(assertionText(profile({ assertions: 1, assertionKinds: { interaction: 1 } }))).toBe('1 Assertion (Interaktion)');
    expect(casesText(profile({ parameterized: true, cases: null }))).toBe('parametrisiert');
    expect(casesText(profile({ parameterized: true, cases: 1 }))).toBe('1 Fall');
  });

  it('summarises scenarios, levels and parameterised cases, most first', () => {
    const profiles = [
      ...Array.from({ length: 9 }, () => profile({})),
      ...Array.from({ length: 4 }, () => profile({ scenario: 'error', level: 'integration' })),
      profile({ scenario: 'edge', parameterized: true, cases: 5 }),
    ];
    profiles[0] = profile({ parameterized: true, cases: 4 });
    const s = profileSummary(profiles);
    const text = `${s.total} Tests · ` + s.groups.map((g) => g.map((p) => p.text).join(', ')).join(' · ');
    expect(text).toBe('14 Tests · 9 Normalfall, 4 Fehlerfall, 1 Grenzfall · 10 Unit, 4 Integration · 2 parametrisiert (9 Fälle)');
    expect(s.groups[0][1].filter).toEqual({ kind: 'scenario', value: 'error' });

    const unknown = profileSummary([profile({ parameterized: true, cases: 3 }), profile({ parameterized: true, cases: null })]);
    expect(unknown.groups.at(-1)![0].text).toBe('2 parametrisiert (mind. 3 Fälle)');
  });

  it('filters by a summary part', () => {
    const error = profile({ scenario: 'error' });
    expect(matchesFilter(error, { kind: 'scenario', value: 'error' })).toBe(true);
    expect(matchesFilter(error, { kind: 'scenario', value: 'edge' })).toBe(false);
    expect(matchesFilter(error, { kind: 'parameterized' })).toBe(false);
    expect(matchesFilter(error, null)).toBe(true);
  });

  it('sorts by column, stable, and toggles the direction on the same column', () => {
    const rows: ProfileRow[] = [
      { id: 'a', name: 'b test', profile: profile({ scenario: 'normal', assertions: 2 }) },
      { id: 'b', name: 'a test', profile: profile({ scenario: 'error', assertions: 2 }) },
      { id: 'c', name: 'c test', profile: profile({ scenario: 'edge', assertions: 5, parameterized: true, cases: null }) },
    ];
    expect(sortRows(rows, { column: 'scenario', desc: false }).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, { column: 'assertions', desc: true }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, { column: 'name', desc: false }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, { column: 'cases', desc: true }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, null)).toBe(rows);
    expect(nextSort(null, 'level')).toEqual({ column: 'level', desc: false });
    expect(nextSort({ column: 'level', desc: false }, 'level')).toEqual({ column: 'level', desc: true });
    expect(nextSort({ column: 'level', desc: true }, 'mocks')).toEqual({ column: 'mocks', desc: false });
  });
});
