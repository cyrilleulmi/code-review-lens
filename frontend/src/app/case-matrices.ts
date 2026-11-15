import { CaseColumn, CaseMatrix, CaseMatrixKind, CaseRow } from './api';

/** Fallmatrix: summary, template slots, duplicate notes and covered values (pure helpers of the case-matrix view). */

export const KIND_LABELS: Record<CaseMatrixKind, string> = { similar: 'ähnliche Tests', parameterized: 'parametrisiert' };

/** A piece of the template: plain code, or a slot ‹n› pointing at column n-1. */
export interface TemplatePart {
  text: string;
  /** index of the column, null for plain code */
  column: number | null;
  /** the slot belongs to an expected column */
  expected: boolean;
}

/** «3 Matrizen · 14 Fälle · 1 doppelt · 1 widersprüchlich» (doppelt / widersprüchlich only when there are any). */
export function matrixSummary(matrices: CaseMatrix[]): { text: string; warn: string | null } {
  const cases = matrices.reduce((n, m) => n + m.rows.length, 0);
  const duplicates = matrices.reduce((n, m) => n + m.rows.filter((r) => r.duplicateOf != null).length, 0);
  const contradictions = matrices.reduce((n, m) => n + m.rows.filter((r) => r.contradicts).length, 0);
  const text = `${matrices.length} ${matrices.length === 1 ? 'Matrix' : 'Matrizen'} · ${cases} ${cases === 1 ? 'Fall' : 'Fälle'}`;
  const warn = [duplicates ? `${duplicates} doppelt` : '', contradictions ? `${contradictions} widersprüchlich` : '']
    .filter((s) => s)
    .join(' · ');
  return { text, warn: warn || null };
}

/** The template split at its slots ‹1›, ‹2›, … (slot n = column n-1). */
export function templateParts(m: CaseMatrix): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const slot = /‹(\d+)›/g;
  let at = 0;
  for (let match = slot.exec(m.template); match; match = slot.exec(m.template)) {
    if (match.index > at) {
      parts.push({ text: m.template.substring(at, match.index), column: null, expected: false });
    }
    const column = Number(match[1]) - 1;
    parts.push({ text: match[0], column, expected: m.columns[column]?.role === 'expected' });
    at = match.index + match[0].length;
  }
  if (at < m.template.length) {
    parts.push({ text: m.template.substring(at), column: null, expected: false });
  }
  return parts;
}

/** Index of the first expected column (where the separator goes), columns.length when there is none. */
export function firstExpected(m: CaseMatrix): number {
  const i = m.columns.findIndex((c) => c.role === 'expected');
  return i < 0 ? m.columns.length : i;
}

/** «0, 7, 23, 150» under an input column, '' for expected columns. */
export function coveredText(c: CaseColumn): string {
  return c.role === 'input' ? c.values.join(', ') : '';
}

/** A cell: the value as written, «–» when the test does not check it. */
export function cellText(value: string | null): string {
  return value ?? '–';
}

/** «gleicher Fall wie setsJerseyNumberSeven» / «gleiche Eingabe, andere Erwartung als …», null for other rows. */
export function duplicateNote(m: CaseMatrix, row: CaseRow): string | null {
  if (row.duplicateOf == null) {
    return null;
  }
  const other = m.rows[row.duplicateOf]?.name ?? `Zeile ${row.duplicateOf + 1}`;
  return row.contradicts ? `gleiche Eingabe, andere Erwartung als ${other}` : `gleicher Fall wie ${other}`;
}

/** Tooltip of a row: what clicking does. */
export function rowTip(row: CaseRow, hasBlock: boolean): string {
  const where = row.line != null ? ` (Zeile ${row.line})` : '';
  return hasBlock
    ? `${row.name}${where} – zum Test springen`
    : `${row.name}${where} – unveränderter Test, in der Dateiansicht zeigen`;
}
