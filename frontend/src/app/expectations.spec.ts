import { describe, expect, it } from 'vitest';
import { SpecEntry } from './api';
import { expectationMarks, expectationTotals, expectationWarning } from './expectations';

function test(partial: Partial<SpecEntry>): SpecEntry {
  return {
    name: 't', suites: [], kind: 'test', status: 'changed', previousName: null, segmentId: null, line: 1, oldLine: 1,
    depth: 0, expectations: [], assertionsBefore: 1, assertionsAfter: 1, disabled: false, ...partial,
  };
}

describe('expectation marks (Spec-Diff)', () => {
  it('warns about changed, weakened and removed assertions and a dropping count', () => {
    const e = test({
      assertionsBefore: 3,
      assertionsAfter: 1,
      expectations: [
        { kind: 'changed', oldText: 'expect(a).toBe(1)', newText: 'expect(a).toBe(2)', oldLine: 3, newLine: 3 },
        { kind: 'weakened', oldText: 'expect(b).toBe(1)', newText: 'expect(b).toBeTruthy()', oldLine: 4, newLine: 4 },
        { kind: 'removed', oldText: 'expect(c).toBe(1)', newText: null, oldLine: 5, newLine: null },
        { kind: 'removed', oldText: 'expect(d).toBe(1)', newText: null, oldLine: 6, newLine: null },
      ],
    });
    expect(expectationMarks(e)).toEqual([
      { label: 'abgeschwächt', warn: true },
      { label: 'Erwartung geändert', warn: true },
      { label: '2 Assertions entfernt', warn: true },
      { label: '3 → 1 Assertions', warn: true },
    ]);
  });

  it('shows a switched-off test even without changes, as a warning only when switched off now', () => {
    expect(expectationMarks(test({ status: 'unchanged', disabled: true }))).toEqual([{ label: 'deaktiviert', warn: false }]);
    const now = test({ disabled: true, expectations: [{ kind: 'disabled', oldText: null, newText: "xit('t'", oldLine: null, newLine: 2 }] });
    expect(expectationMarks(now)).toEqual([{ label: 'deaktiviert', warn: true }]);
  });

  it('only added assertions are neutral', () => {
    const e = test({ assertionsAfter: 2, expectations: [{ kind: 'added', oldText: null, newText: 'expect(x).toBe(1)', oldLine: null, newLine: 4 }] });
    expect(expectationMarks(e)).toEqual([{ label: '+1 Assertion', warn: false }]);
  });

  it('counts tests, not suites, for the warning line', () => {
    const disabled = { kind: 'disabled' as const, oldText: null, newText: "xdescribe('s'", oldLine: null, newLine: 1 };
    const files = [{
      path: 'a.spec.ts', previousPath: null, status: 'modified', baseAvailable: true,
      entries: [
        test({ kind: 'suite', expectations: [disabled] }),
        test({ expectations: [disabled] }),
        test({ expectations: [{ kind: 'removed', oldText: 'x', newText: null, oldLine: 1, newLine: null }] }),
        test({ expectations: [{ kind: 'added', oldText: null, newText: 'x', oldLine: null, newLine: 1 }] }),
      ],
    }];
    const totals = expectationTotals(files);
    expect(totals).toEqual({ changed: 1, disabled: 1 });
    expect(expectationWarning(totals)).toBe('⚠ 1 Erwartung geändert · 1 deaktiviert');
    expect(expectationWarning({ changed: 0, disabled: 0 })).toBeNull();
  });
});
