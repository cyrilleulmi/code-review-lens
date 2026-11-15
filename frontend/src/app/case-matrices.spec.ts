import { describe, expect, it } from 'vitest';
import { CaseMatrix } from './api';
import { cellText, coveredText, duplicateNote, firstExpected, matrixSummary, templateParts } from './case-matrices';

function jersey(): CaseMatrix {
  return {
    id: 'm1',
    path: 'backend/src/test/java/JerseyNumberApiTest.java',
    title: 'JerseyNumberApiTest › putJerseyNumber(…)',
    kind: 'similar',
    template: 'putJerseyNumber(‹1›).then().statusCode(‹2›);',
    columns: [
      { label: 'putJerseyNumber(…) Arg 1', role: 'input', values: ['0', '7', '23', '150'] },
      { label: 'statusCode', role: 'expected', values: [] },
    ],
    rows: [
      { name: 'setsJerseyNumberSeven', segmentId: 's1', line: 43, values: ['7', '200'], duplicateOf: null, contradicts: false },
      { name: 'rejectsJerseyNumberZero', segmentId: 's2', line: 53, values: ['0', '400'], duplicateOf: null, contradicts: false },
      { name: 'storesTheLuckyNumber', segmentId: null, line: 63, values: ['7', '200'], duplicateOf: 0, contradicts: false },
      { name: 'rejectsSevenToo', segmentId: 's4', line: 68, values: ['7', '400'], duplicateOf: 0, contradicts: true },
    ],
  };
}

describe('case matrix (Fallmatrix)', () => {
  it('summarises matrices, cases, duplicates and contradictions', () => {
    expect(matrixSummary([jersey()])).toEqual({ text: '1 Matrix · 4 Fälle', warn: '2 doppelt · 1 widersprüchlich' });
    const single = { ...jersey(), rows: jersey().rows.slice(0, 1) };
    expect(matrixSummary([single, single])).toEqual({ text: '2 Matrizen · 2 Fälle', warn: null });
  });

  it('splits the template at its slots and knows input from expected slots', () => {
    const parts = templateParts(jersey());
    expect(parts.map((p) => p.text)).toEqual(['putJerseyNumber(', '‹1›', ').then().statusCode(', '‹2›', ');']);
    expect(parts[1]).toEqual({ text: '‹1›', column: 0, expected: false });
    expect(parts[3].expected).toBe(true);
    expect(firstExpected(jersey())).toBe(1);
  });

  it('explains duplicates and shows covered values', () => {
    const m = jersey();
    expect(duplicateNote(m, m.rows[0])).toBeNull();
    expect(duplicateNote(m, m.rows[2])).toBe('gleicher Fall wie setsJerseyNumberSeven');
    expect(duplicateNote(m, m.rows[3])).toBe('gleiche Eingabe, andere Erwartung als setsJerseyNumberSeven');
    expect(coveredText(m.columns[0])).toBe('0, 7, 23, 150');
    expect(coveredText(m.columns[1])).toBe('');
    expect(cellText(null)).toBe('–');
  });
});
