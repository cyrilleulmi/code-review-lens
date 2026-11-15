import { describe, expect, it } from 'vitest';
import { AffectedTest, SetupImpact } from './api';
import {
  affectedList, countUnchangedAffected, distinctAffected, impactBadge, impactNotice, impactWarns, markerTitle, setupTileText,
  sortImpacts, unchangedAffected, unchangedAffectedText,
} from './setup-impact';

function test(partial: Partial<AffectedTest>): AffectedTest {
  return { path: 'src/app/p.spec.ts', name: 'PlayerView › shows it', line: 10, segmentId: null, status: 'unchanged', existing: false, ...partial };
}

function impact(partial: Partial<SetupImpact>): SetupImpact {
  const affected = partial.affected ?? [];
  return { segmentId: 's1', kind: 'fixture', name: 'CARMELA', line: 1, affected,
    unchangedCount: affected.filter((t) => t.status === 'unchanged').length, ...partial };
}

describe('setup impact', () => {
  const carmela = impact({
    affected: [test({ line: 10 }), test({ line: 20, status: 'changed', segmentId: 's5', name: 'PlayerView › saves it' }),
      test({ line: 30 }), test({ path: 'src/app/list.spec.ts', line: 4, existing: true, name: 'PlayerList › lists' })],
  });
  const helper = impact({ segmentId: 's9', kind: 'helper', name: 'TestData.player', affected: [test({ status: 'added', line: 50 })] });

  it('words the notice, warning only when unchanged tests are affected', () => {
    expect(impactNotice(carmela)).toBe('Testdaten geändert: CARMELA wirkt auf 4 Tests, davon 3 unverändert');
    expect(impactNotice(helper)).toBe('Testhilfe geändert: TestData.player wirkt auf 1 Test (alle neu oder geändert)');
    expect(impactNotice(impact({ kind: 'setup', name: 'PlayerView › beforeEach', affected: [test({})] })))
      .toBe('Setup geändert: PlayerView › beforeEach wirkt auf 1 Test, davon 1 unverändert');
    expect(impactWarns(carmela)).toBe(true);
    expect(impactWarns(helper)).toBe(false);
    expect(sortImpacts([helper, carmela]).map((i) => i.name)).toEqual(['CARMELA', 'TestData.player']);
  });

  it('builds the header badge over the distinct tests of a segment', () => {
    const second = impact({ name: 'OTHER', affected: [test({ line: 10 }), test({ line: 40, status: 'added' })] });
    expect(distinctAffected([carmela, second]).length).toBe(5);
    const badge = impactBadge([carmela, second])!;
    expect(badge.text).toBe('wirkt auf 5 Tests (3 unverändert)');
    expect(badge.warn).toBe(true);
    expect(badge.title).toContain('Testdaten geändert: CARMELA\nTestdaten geändert: OTHER');
    expect(badge.title).toContain('· PlayerList › lists (unverändert, bestehende Datei) – list.spec.ts:4');
    expect(impactBadge([helper])).toEqual(expect.objectContaining({ text: 'wirkt auf 1 Test', warn: false }));
    expect(impactBadge(undefined)).toBeNull();
    expect(affectedList([test({ status: 'changed', line: 7 })])).toBe('· PlayerView › shows it (geändert) – p.spec.ts:7');
  });

  it('finds the unchanged affected tests for the outline and counts them', () => {
    const byPath = unchangedAffected([carmela, helper, impact({ name: 'X', affected: [test({ line: 10 })] })]);
    expect([...byPath.get('src/app/p.spec.ts')!.keys()]).toEqual([10, 30]);
    expect(byPath.get('src/app/p.spec.ts')!.get(10)!.map((i) => i.name)).toEqual(['CARMELA', 'X']);
    expect(byPath.get('src/app/list.spec.ts')!.has(4)).toBe(true);
    expect(countUnchangedAffected([carmela, helper])).toBe(3);
    expect(countUnchangedAffected(null)).toBe(0);
    expect(markerTitle([carmela])).toContain('Testdaten geändert: CARMELA');
  });

  it('words the counts', () => {
    expect(unchangedAffectedText(0)).toBeNull();
    expect(unchangedAffectedText(3)).toBe('3 unveränderte, aber betroffen');
    expect(setupTileText(0)).toBeNull();
    expect(setupTileText(1)).toBe('Setup/Testdaten geändert: wirkt auf 1 unveränderten Test');
    expect(setupTileText(10)).toBe('Setup/Testdaten geändert: wirkt auf 10 unveränderte Tests');
  });
});
