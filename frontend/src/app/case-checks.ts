import { CaseFinding, CodeCoverage, MatrixBoundary } from './api';

/**
 * Fall- und Effekt-Abgleich: pure helpers for the coverage view, the line chips of code blocks and the Fallmatrix.
 * A finding is «open» when no reaching test checks it; «branches» is information only and never open.
 */

/** An unchecked finding that needs attention (not the branch information). */
export function isOpen(f: CaseFinding): boolean {
  return !f.checked && f.kind !== 'branches';
}

/** The open findings of a coverage entry, in line order. */
export function openFindings(c: CodeCoverage): CaseFinding[] {
  return (c.findings ?? []).filter(isOpen);
}

/** «7 offene Fälle in 4 Funktionen»; null when nothing is open. */
export function findingsSummary(coverage: CodeCoverage[]): string | null {
  let open = 0;
  let functions = 0;
  for (const c of coverage) {
    const n = openFindings(c).length;
    open += n;
    functions += n > 0 ? 1 : 0;
  }
  if (open === 0) return null;
  return `${open} ${open === 1 ? 'offener Fall' : 'offene Fälle'} in ${functions} ${functions === 1 ? 'Funktion' : 'Funktionen'}`;
}

/** The short form of a finding in the compact line: «NotFoundException ungeprüft», «Grenze 1…99: 1, 99 fehlen». */
export function compactText(f: CaseFinding): string {
  switch (f.kind) {
    case 'boundary':
      return f.missing.length ? `${f.label}: ${f.missing.join(', ')} ${f.missing.length === 1 ? 'fehlt' : 'fehlen'}` : `${f.label} geprüft`;
    case 'branches':
      return f.label;
    default:
      return `${f.subject ?? f.label} ${f.checked ? 'geprüft' : 'ungeprüft'}`;
  }
}

/** The compact line of a coverage entry: open findings first, then the branch information. */
export function compactLine(c: CodeCoverage): string[] {
  const findings = c.findings ?? [];
  return [...findings.filter(isOpen), ...findings.filter((f) => f.kind === 'branches')].map(compactText);
}

/** The chip on the code line of an open finding: «kein Test erwartet NotFoundException». */
export function lineChipText(f: CaseFinding): string {
  switch (f.kind) {
    case 'exception':
      return `kein Test erwartet ${f.subject ?? 'diesen Fehler'}`;
    case 'boundary':
      return `Grenze nicht geprüft: ${f.missing.join(', ')}`;
    default:
      return `Wirkung ungeprüft: ${f.subject ?? f.label}`;
  }
}

/** What a finding means in full, for the expanded list and tooltips; testName resolves test ids. */
export function findingDetail(f: CaseFinding, testName: (id: string) => string): string {
  const by = f.checkedBy.map(testName).join(', ');
  switch (f.kind) {
    case 'boundary': {
      const covered = f.covered.length ? f.covered.join(', ') : 'keine Zahlen';
      return `${f.label}: geprüft ${covered}` + (f.missing.length ? ` – nicht geprüft: ${f.missing.join(', ')}` : ' – alle Grenzwerte geprüft');
    }
    case 'branches':
      return `${f.label} – mehr Entscheidungen als Tests (Hinweis, keine Warnung)`;
    default:
      return f.checked ? `${f.label} – geprüft von ${by}` : `${f.label} – kein Test prüft das`;
  }
}

/** Open findings by new-file line (for the line chips of a code block). */
export function findingsByLine(c: CodeCoverage | undefined): Map<number, CaseFinding[]> {
  const result = new Map<number, CaseFinding[]>();
  for (const f of c ? openFindings(c) : []) {
    if (f.line == null) continue;
    result.set(f.line, [...(result.get(f.line) ?? []), f]);
  }
  return result;
}

/** «Grenze im Code (isInRange): 1…99 – in dieser Matrix fehlen 1, 99» */
export function boundaryNote(b: MatrixBoundary, symbol: string | null): string {
  const where = symbol ? ` (${symbol})` : '';
  const head = `Grenze im Code${where}: ${b.subject} ${b.label} – Grenzwerte ${b.values.join(', ')}`;
  return b.missing.length ? `${head} – in dieser Matrix fehlen ${b.missing.join(', ')}` : `${head} – alle in der Matrix`;
}
