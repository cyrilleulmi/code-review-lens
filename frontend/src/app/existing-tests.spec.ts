import { describe, expect, it } from 'vitest';
import { ExistingTest, RelatedTests } from './api';
import { basisText, basisWarnings, existingChip } from './existing-tests';

const related = (over: Partial<RelatedTests> = {}): RelatedTests => ({
  limit: 30,
  candidates: 2,
  truncated: false,
  listIncomplete: false,
  files: [
    { path: 'src/a.spec.ts', reason: 'mirror', sources: ['src/a.ts'], loaded: true },
    { path: 'src/b.spec.ts', reason: 'name', sources: ['src/b.ts'], loaded: false },
  ],
  ...over,
});

describe('existing tests (Bestehende Tests)', () => {
  it('states the basis of the coverage', () => {
    expect(basisText(null)).toBe('Grundlage: geänderte Tests im PR');
    expect(basisText(related())).toBe('Grundlage: geänderte Tests im PR + 1 nachgeladene Testdatei (Namenskonvention) · 1 nicht ladbar');
    expect(basisText(related({ files: [] }))).toContain('keine bestehende Testdatei');
  });

  it('warns when the limit or the file list cut the selection', () => {
    expect(basisWarnings(related())).toEqual([]);
    expect(basisWarnings(related({ truncated: true, candidates: 40 }))[0]).toContain('2 von 40');
    expect(basisWarnings(related({ listIncomplete: true }))).toHaveLength(1);
  });

  it('builds a chip with file:line and the selection reason', () => {
    const test: ExistingTest = {
      id: 'e1', path: 'src/app/a.spec.ts', name: 'A › works', line: 12, reason: 'mirror', profile: null,
      covers: [{ segmentId: 's1', direct: true, via: null, line: 14 }, { segmentId: 's2', direct: false, via: 's1', line: 14 }],
    };
    const chip = existingChip(test, 's2');
    expect(chip.where).toBe('a.spec.ts:12');
    expect(chip.title).toContain('src/app/a.spec.ts:12');
    expect(chip.title).toContain('über anderen geänderten Code');
    expect(chip.title).toContain('Namenskonvention');
    expect(existingChip(test, 's1').title).toContain('direkt');
  });
});
