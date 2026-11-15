import { describe, expect, it } from 'vitest';
import { TestProfile, TestSmell } from './api';
import { ProfileRow, matchesFilter, profileSummary, sortRows } from './test-profile';
import { countWithSmells, smellBadgeText, smellBadgeTitle, smellDetail, smellsByLine, smellsSummary } from './test-smells';

function smell(partial: Partial<TestSmell>): TestSmell {
  return { kind: 'no-assertion', label: 'keine Assertion', line: null, code: null, hint: 'Der Test prüft nichts.', ...partial };
}

describe('test smells', () => {
  it('words the badge, the tooltips and the summary', () => {
    const a = smell({});
    const b = smell({ kind: 'sleep', label: 'wartet mit sleep', line: 41, code: 'Thread.sleep(2000);', hint: 'Feste Wartezeit.' });
    expect(smellBadgeText([a])).toBe('Smell: keine Assertion');
    expect(smellBadgeText([a, b])).toBe('Smell: keine Assertion, wartet mit sleep');
    expect(smellBadgeTitle([a, b])).toContain('wartet mit sleep: Feste Wartezeit.');
    expect(smellDetail(b)).toBe('Feste Wartezeit.\nZeile 41: Thread.sleep(2000);\n– Musterbasiert erkannt (Test-Smells)');
    expect(smellDetail(a)).not.toContain('Zeile');
    expect(smellsSummary(0)).toBeNull();
    expect(smellsSummary(1)).toBe('1 Test mit Smells');
    expect(smellsSummary(5)).toBe('5 Tests mit Smells');
  });

  it('counts tests with smells and groups them by line', () => {
    const smells = [smell({ line: 3 }), smell({ kind: 'sleep', label: 'wartet mit sleep', line: 3 }), smell({ kind: 'focused', line: 7 }), smell({})];
    expect(countWithSmells([{ smells }, { smells: [] }, {}])).toBe(1);
    const byLine = smellsByLine(smells);
    expect([...byLine.keys()]).toEqual([3, 7]);
    expect(byLine.get(3)!.map((s) => s.kind)).toEqual(['no-assertion', 'sleep']);
    expect(smellsByLine(undefined).size).toBe(0);
  });

  it('adds the smells to the summary of the table, filters and sorts by them', () => {
    const profile: TestProfile = { targets: [], scenario: 'normal', scenarioBy: null, scenarioReason: null, assertions: 1, assertionKinds: { equality: 1 },
      mocks: [], level: 'unit', levelBy: null, levelReason: null, parameterized: false, cases: null, casesSource: null };
    const s = profileSummary([profile, profile, profile], 2);
    const last = s.groups.at(-1)![0];
    expect(last.text).toBe('2 Tests mit Smells');
    expect(last.filter).toEqual({ kind: 'smells' });
    expect(profileSummary([profile]).groups.some((g) => g[0].filter.kind === 'smells')).toBe(false);

    expect(matchesFilter(profile, { kind: 'smells' }, [smell({})])).toBe(true);
    expect(matchesFilter(profile, { kind: 'smells' }, [])).toBe(false);
    expect(matchesFilter(profile, { kind: 'smells' })).toBe(false);

    const rows: ProfileRow[] = [
      { id: 'a', name: 'a', profile, smells: [] },
      { id: 'b', name: 'b', profile, smells: [smell({}), smell({ kind: 'sleep' })] },
      { id: 'c', name: 'c', profile, smells: [smell({})] },
    ];
    expect(sortRows(rows, { column: 'smells', desc: true }).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});
