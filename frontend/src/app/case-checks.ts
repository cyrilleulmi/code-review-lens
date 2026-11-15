import { CaseFinding, CodeCoverage, MatrixBoundary } from './api';
import { serverText, t } from './i18n';

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
  return t(open === 1 ? '{n} offener Fall' : '{n} offene Fälle', { n: open }) + ' '
    + t(functions === 1 ? 'in {n} Funktion' : 'in {n} Funktionen', { n: functions });
}

/** The short form of a finding in the compact line: «NotFoundException ungeprüft», «Grenze 1…99: 1, 99 fehlen». */
export function compactText(f: CaseFinding): string {
  const label = serverText(f.label);
  switch (f.kind) {
    case 'boundary':
      return f.missing.length
        ? t(f.missing.length === 1 ? '{label}: {values} fehlt' : '{label}: {values} fehlen', { label, values: f.missing.join(', ') })
        : t('{label} geprüft', { label });
    case 'branches':
      return label;
    default:
      return t(f.checked ? '{label} geprüft' : '{label} ungeprüft', { label: f.subject ?? label });
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
      return f.subject ? t('kein Test erwartet {subject}', { subject: f.subject }) : t('kein Test erwartet diesen Fehler');
    case 'boundary':
      return t('Grenze nicht geprüft: {values}', { values: f.missing.join(', ') });
    default:
      return t('Wirkung ungeprüft: {subject}', { subject: f.subject ?? serverText(f.label) });
  }
}

/** What a finding means in full, for the expanded list and tooltips; testName resolves test ids. */
export function findingDetail(f: CaseFinding, testName: (id: string) => string): string {
  const by = f.checkedBy.map(testName).join(', ');
  const label = serverText(f.label);
  switch (f.kind) {
    case 'boundary': {
      const covered = f.covered.length ? f.covered.join(', ') : t('keine Zahlen');
      return t('{label}: geprüft {covered}', { label, covered })
        + (f.missing.length ? t(' – nicht geprüft: {values}', { values: f.missing.join(', ') }) : t(' – alle Grenzwerte geprüft'));
    }
    case 'branches':
      return t('{label} – mehr Entscheidungen als Tests (Hinweis, keine Warnung)', { label });
    default:
      return f.checked ? t('{label} – geprüft von {by}', { label, by }) : t('{label} – kein Test prüft das', { label });
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
  const head = t('Grenze im Code{where}: {subject} {label} – Grenzwerte {values}', { where, subject: b.subject, label: b.label, values: b.values.join(', ') });
  return b.missing.length
    ? head + t(' – in dieser Matrix fehlen {values}', { values: b.missing.join(', ') })
    : head + t(' – alle in der Matrix');
}
