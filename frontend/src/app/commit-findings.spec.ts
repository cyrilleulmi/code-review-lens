import { describe, expect, it } from 'vitest';
import { CommitFinding } from './api';
import {
  commitChips, findingSummary, findingTotals, laterExpectationChip, laterExpectationText, laterExpectationsByLine,
  laterExpectationsByTest, newLineOf,
} from './commit-findings';

function finding(partial: Partial<CommitFinding>): CommitFinding {
  return {
    kind: 'logic-without-test', level: 'info', sha: '5b6cfdc0000000000000000000000000000000000', title: 'Clear jersey number',
    path: 'src/app/player-view.ts', lineKey: 'N219', segmentId: 's93', testSegmentId: null, detail: 'PlayerView.clearJerseyNumber geändert',
    ...partial,
  };
}

const FIX = finding({ kind: 'fix-without-test', level: 'warn', sha: '9cb532b111', title: 'Fix jersey number rounding', detail: 'Fix ohne Test' });
const LATER = finding({
  kind: 'expectation-later', level: 'warn', sha: '406522a222', title: 'fix tests', path: 'JerseyNumberValidationTest.java',
  lineKey: 'N62', segmentId: 's37', testSegmentId: 's37', detail: 'Erwartung nachträglich geändert',
});

describe('commit findings', () => {
  it('builds the chips of one commit, by kind, with a count', () => {
    const second = finding({ segmentId: 's94' });
    const findings = [finding({}), FIX, second, LATER];
    const chips = commitChips(findings, '5b6cfdc0000000000000000000000000000000000');
    expect(chips.map((c) => c.label)).toEqual(['Logik ohne Test ×2']);
    expect(chips[0].warn).toBe(false);
    expect(chips[0].title).toContain('PlayerView.clearJerseyNumber geändert');
    expect(commitChips(findings, '9cb532b111').map((c) => [c.label, c.warn])).toEqual([['Fix ohne Test', true]]);
    expect(commitChips(findings, '406522a222').map((c) => c.label)).toEqual(['passt Erwartungen an']);
    expect(commitChips(null, 'x')).toEqual([]);
  });

  it('counts for the overview', () => {
    const findings = [finding({}), FIX, LATER];
    expect(findingTotals(findings)).toEqual({ commits: 3, warn: 2, info: 1 });
    expect(findingSummary(findings)).toBe('⚠ 2 Commit-Hinweise · 1 Info');
    expect(findingSummary([FIX])).toBe('⚠ 1 Commit-Hinweis');
    expect(findingSummary([finding({}), finding({})])).toBe('2 Infos');
    expect(findingSummary([])).toBeNull();
    expect(findingSummary(undefined)).toBeNull();
  });

  it('words and places a later changed expectation', () => {
    expect(laterExpectationText(LATER)).toBe('Erwartung nachträglich in 406522a «fix tests» geändert');
    expect(laterExpectationChip(LATER)).toBe('Erwartung nachträglich geändert (406522a)');
    expect([...laterExpectationsByTest([FIX, LATER, finding({})]).keys()]).toEqual(['s37']);
    const byLine = laterExpectationsByLine([LATER, FIX], 's37');
    expect([...byLine.keys()]).toEqual([62]);
    expect(laterExpectationsByLine([LATER], 's1').size).toBe(0);
    expect(newLineOf('N62')).toBe(62);
    expect(newLineOf('O12')).toBeNull();
    expect(newLineOf(null)).toBeNull();
  });
});
