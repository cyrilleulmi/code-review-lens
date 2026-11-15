import { ExpectationChange, SpecEntry, SpecFile } from './api';
import { t } from './i18n';

/** A marker of a test in the spec outline / code block header. */
export interface ExpectationMark {
  label: string;
  /** warning (--warn): the test now expects less or something else; else neutral */
  warn: boolean;
}

/** Kinds that bend a test: shown as a warning. */
const BENDING = new Set(['changed', 'weakened', 'removed']);

/** Does the entry change what an existing test expects (changed, weakened or removed assertion)? */
export function bendsExpectations(e: SpecEntry): boolean {
  return (e.expectations ?? []).some((c) => BENDING.has(c.kind));
}

/** Was the entry (or an enclosing suite) switched off in this change? */
export function newlyDisabled(e: SpecEntry): boolean {
  return (e.expectations ?? []).some((c) => c.kind === 'disabled');
}

/** Fewer assertions than in the base version. */
export function assertionDrop(e: SpecEntry): { before: number; after: number } | null {
  const before = e.assertionsBefore;
  const after = e.assertionsAfter;
  return before != null && after != null && after < before ? { before, after } : null;
}

/** Markers of an entry, most severe first. */
export function expectationMarks(e: SpecEntry): ExpectationMark[] {
  const changes = e.expectations ?? [];
  const count = (kind: string) => changes.filter((c) => c.kind === kind).length;
  const marks: ExpectationMark[] = [];
  if (newlyDisabled(e)) {
    marks.push({ label: t('deaktiviert'), warn: true });
  } else if (e.disabled) {
    marks.push({ label: t('deaktiviert'), warn: false });
  }
  if (count('weakened')) {
    marks.push({ label: t('abgeschwächt'), warn: true });
  }
  if (count('changed')) {
    marks.push({ label: t('Erwartung geändert'), warn: true });
  }
  const removed = count('removed');
  if (removed) {
    marks.push({ label: removed === 1 ? t('Assertion entfernt') : t('{n} Assertions entfernt', { n: removed }), warn: true });
  }
  const drop = assertionDrop(e);
  if (drop) {
    marks.push({ label: t('{before} → {after} Assertions', drop), warn: true });
  }
  if (count('enabled')) {
    marks.push({ label: t('wieder aktiviert'), warn: false });
  }
  const added = count('added');
  if (added && !marks.some((m) => m.warn)) {
    marks.push({ label: added === 1 ? t('+1 Assertion') : t('+{n} Assertions', { n: added }), warn: false });
  }
  return marks;
}

/** Counts over spec files: tests whose expectations were bent, tests switched off in this change. */
export function expectationTotals(files: SpecFile[]): { changed: number; disabled: number } {
  let changed = 0;
  let disabled = 0;
  for (const f of files) {
    for (const e of f.entries) {
      if (e.kind !== 'test') continue;
      if (bendsExpectations(e)) changed++;
      if (newlyDisabled(e)) disabled++;
    }
  }
  return { changed, disabled };
}

/** «⚠ 2 Erwartungen geändert · 1 deaktiviert», or null when nothing to warn about. */
export function expectationWarning(totals: { changed: number; disabled: number }): string | null {
  const parts: string[] = [];
  if (totals.changed) parts.push(t(totals.changed === 1 ? '{n} Erwartung geändert' : '{n} Erwartungen geändert', { n: totals.changed }));
  if (totals.disabled) parts.push(t('{n} deaktiviert', { n: totals.disabled }));
  return parts.length ? `⚠ ${parts.join(' · ')}` : null;
}

/** One line of a change for tooltips: «Erwartung geändert: old → new». */
export function describeChange(c: ExpectationChange): string {
  const label = t(KIND_LABELS[c.kind]);
  if (c.oldText && c.newText) return `${label}: ${c.oldText}  →  ${c.newText}`;
  return `${label}: ${c.newText ?? c.oldText ?? ''}`;
}

/** German, translated with t(). */
export const KIND_LABELS: Record<ExpectationChange['kind'], string> = {

  changed: 'Erwartung geändert',
  weakened: 'abgeschwächt',
  removed: 'Assertion entfernt',
  added: 'Assertion ergänzt',
  disabled: 'deaktiviert',
  enabled: 'wieder aktiviert',
};
