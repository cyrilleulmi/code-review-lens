import { CommitFinding, CommitFindingKind } from './api';
import { serverText, t } from './i18n';

/**
 * Commit-Bezug der Tests: pure helpers for the chips in the commit list, the count on the overview, the marker in the
 * test specification and the line chips of a test's code block.
 */

/** Chip texts in the commit list, in the order they are shown (German, translated with t()). */
export const FINDING_LABELS: Record<CommitFindingKind, string> = {
  'fix-without-test': 'Fix ohne Test',
  'expectation-later': 'passt Erwartungen an',
  'logic-without-test': 'Logik ohne Test',
};

const KIND_ORDER: CommitFindingKind[] = ['fix-without-test', 'expectation-later', 'logic-without-test'];

/** One chip of a commit: all its findings of one kind. warn: at least one of them is a warning. */
export interface FindingChip {
  kind: CommitFindingKind;
  label: string;
  count: number;
  warn: boolean;
  title: string;
}

/** The chips of one commit («Fix ohne Test», «passt Erwartungen an ×2», …), by kind; empty without findings. */
export function commitChips(findings: CommitFinding[] | null | undefined, sha: string): FindingChip[] {
  const mine = (findings ?? []).filter((f) => f.sha === sha);
  return KIND_ORDER.flatMap((kind) => {
    const list = mine.filter((f) => f.kind === kind);
    if (!list.length) return [];
    const label = t(FINDING_LABELS[kind]) + (list.length > 1 ? ` ×${list.length}` : '');
    return [{
      kind,
      label,
      count: list.length,
      warn: list.some((f) => f.level === 'warn'),
      title: list.map((f) => serverText(f.detail)).join('\n\n') + '\n' + t('– aus der Reihenfolge der Commits, musterbasiert (Commit-Bezug)'),
    }];
  });
}

/** Commits by sha with the number of their findings (for the overview); warn: of which warnings. */
export function findingTotals(findings: CommitFinding[] | null | undefined): { commits: number; warn: number; info: number } {
  const list = findings ?? [];
  return {
    commits: new Set(list.map((f) => f.sha)).size,
    warn: list.filter((f) => f.level === 'warn').length,
    info: list.filter((f) => f.level !== 'warn').length,
  };
}

/** «⚠ 2 Commit-Hinweise · 3 Infos» for the overview; null without findings. */
export function findingSummary(findings: CommitFinding[] | null | undefined): string | null {
  const totals = findingTotals(findings);
  const parts: string[] = [];
  if (totals.warn) parts.push('⚠ ' + t(totals.warn === 1 ? '{n} Commit-Hinweis' : '{n} Commit-Hinweise', { n: totals.warn }));
  if (totals.info) parts.push(t(totals.info === 1 ? '{n} Info' : '{n} Infos', { n: totals.info }));
  return parts.length ? parts.join(' · ') : null;
}

/** «Erwartung nachträglich in 406522a «fix tests» geändert» (marker in the specification and line chip). */
export function laterExpectationText(f: CommitFinding): string {
  return t('Erwartung nachträglich in {sha} «{title}» geändert', { sha: f.sha.substring(0, 7), title: f.title });
}

/** Short form for the line chip in a code block. */
export function laterExpectationChip(f: CommitFinding): string {
  return t('Erwartung nachträglich geändert ({sha})', { sha: f.sha.substring(0, 7) });
}

/** expectation-later findings by test segment id. */
export function laterExpectationsByTest(findings: CommitFinding[] | null | undefined): Map<string, CommitFinding[]> {
  const result = new Map<string, CommitFinding[]>();
  for (const f of findings ?? []) {
    if (f.kind !== 'expectation-later' || !f.testSegmentId) continue;
    result.set(f.testSegmentId, [...(result.get(f.testSegmentId) ?? []), f]);
  }
  return result;
}

/** New-file line of a line key ("N62" -> 62); null for deleted lines and missing keys. */
export function newLineOf(key: string | null | undefined): number | null {
  if (!key || key[0] !== 'N') return null;
  const n = Number(key.substring(1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** expectation-later findings of one segment by the new-file line they show at. */
export function laterExpectationsByLine(findings: CommitFinding[] | null | undefined, segmentId: string): Map<number, CommitFinding[]> {
  const result = new Map<number, CommitFinding[]>();
  for (const f of findings ?? []) {
    const line = newLineOf(f.lineKey);
    if (f.kind !== 'expectation-later' || f.segmentId !== segmentId || line == null) continue;
    result.set(line, [...(result.get(line) ?? []), f]);
  }
  return result;
}
