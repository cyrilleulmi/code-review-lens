import { describe, expect, it } from 'vitest';
import { CaseFinding, CodeCoverage } from './api';
import { boundaryNote, compactLine, findingDetail, findingsByLine, findingsSummary, isOpen, lineChipText } from './case-checks';

function finding(over: Partial<CaseFinding>): CaseFinding {
  return { kind: 'effect', line: 10, code: null, label: '', subject: null, checked: false, checkedBy: [], covered: [], missing: [], ...over };
}

const notFound = finding({ kind: 'exception', line: 90, label: 'wirft NotFoundException (404)', subject: 'NotFoundException' });
const range = finding({ kind: 'boundary', line: 225, label: 'Grenze 1…99', subject: 'jerseyNumber', covered: ['0', '7', '100'], missing: ['1', '99'] });
const changedAt = finding({ line: 78, label: 'setzt jerseyNumberChangedAt', subject: 'jerseyNumberChangedAt' });
const number = finding({ line: 77, label: 'setzt jerseyNumber', subject: 'jerseyNumber', checked: true, checkedBy: ['s41'] });
const branches = finding({ kind: 'branches', line: null, label: '5 Verzweigungen, 2 Tests' });

function coverage(findings: CaseFinding[]): CodeCoverage {
  return { segmentId: 's1', status: 'direct', directTests: ['s41'], indirectTests: [], branches: 5, changedLines: 4, risk: 24, findings };
}

describe('case checks (Fall- und Effekt-Abgleich)', () => {
  it('treats unchecked findings as open, branch information never', () => {
    expect(isOpen(notFound)).toBe(true);
    expect(isOpen(number)).toBe(false);
    expect(isOpen(branches)).toBe(false);
  });

  it('builds the compact line with open findings first and the branch hint last', () => {
    expect(compactLine(coverage([branches, notFound, number, range, changedAt]))).toEqual([
      'NotFoundException ungeprüft',
      'Grenze 1…99: 1, 99 fehlen',
      'jerseyNumberChangedAt ungeprüft',
      '5 Verzweigungen, 2 Tests',
    ]);
  });

  it('summarises open findings over functions', () => {
    expect(findingsSummary([coverage([notFound, range]), coverage([number, branches]), coverage([changedAt])])).toBe('3 offene Fälle in 2 Funktionen');
    expect(findingsSummary([coverage([number])])).toBeNull();
    expect(findingsSummary([coverage([changedAt]), { ...coverage([]), findings: undefined }])).toBe('1 offener Fall in 1 Funktion');
  });

  it('labels line chips and details', () => {
    expect(lineChipText(notFound)).toBe('kein Test erwartet NotFoundException');
    expect(lineChipText(range)).toBe('Grenze nicht geprüft: 1, 99');
    expect(lineChipText(changedAt)).toBe('Wirkung ungeprüft: jerseyNumberChangedAt');
    expect(findingDetail(range, (id) => id)).toBe('Grenze 1…99: geprüft 0, 7, 100 – nicht geprüft: 1, 99');
    expect(findingDetail(number, (id) => (id === 's41' ? 'savesJerseyNumber' : id))).toBe('setzt jerseyNumber – geprüft von savesJerseyNumber');
    expect(findingDetail(notFound, (id) => id)).toBe('wirft NotFoundException (404) – kein Test prüft das');
  });

  it('groups open findings by line', () => {
    const byLine = findingsByLine(coverage([notFound, number, branches, changedAt]));
    expect([...byLine.keys()]).toEqual([90, 78]);
    expect(findingsByLine(undefined).size).toBe(0);
  });

  it('writes the boundary note of a case matrix', () => {
    const b = { segmentId: 's6', subject: 'jerseyNumber', label: '1…99', values: ['0', '1', '99', '100'], missing: ['1', '99'] };
    expect(boundaryNote(b, 'PlayerResource.isInRange')).toBe(
      'Grenze im Code (PlayerResource.isInRange): jerseyNumber 1…99 – Grenzwerte 0, 1, 99, 100 – in dieser Matrix fehlen 1, 99',
    );
    expect(boundaryNote({ ...b, missing: [] }, null)).toBe('Grenze im Code: jerseyNumber 1…99 – Grenzwerte 0, 1, 99, 100 – alle in der Matrix');
  });
});
