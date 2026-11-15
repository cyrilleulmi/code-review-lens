import { ExistingTest, RelatedReason, RelatedTests } from './api';
import { httpCover, httpTitle } from './http-tests';
import { t } from './i18n';

/** Why an existing test file was loaded, in words (tooltip). */
export function reasonLabel(reason: RelatedReason): string {
  switch (reason) {
    case 'mirror':
      return t('Namenskonvention: Testdatei der geänderten Datei, im gespiegelten Testordner oder daneben');
    case 'name':
      return t('Namenskonvention: Testdatei gleichen Namens an anderem Ort (die nächstgelegene)');
    case 'prefix':
      return t('Name beginnt mit dem Namen der geänderten Datei, im gespiegelten Testordner');
  }
}

/** The basis of the coverage: changed tests plus the existing test files loaded for the change. */
export function basisText(related: RelatedTests | null | undefined): string {
  if (!related) {
    return t('Grundlage: geänderte Tests im PR');
  }
  const loaded = related.files.filter((f) => f.loaded).length;
  const failed = related.files.length - loaded;
  if (related.files.length === 0) {
    return t('Grundlage: geänderte Tests im PR · keine bestehende Testdatei nach Namenskonvention gefunden');
  }
  const files = loaded === 1 ? t('1 nachgeladene Testdatei') : t('{n} nachgeladene Testdateien', { n: loaded });
  return t('Grundlage: geänderte Tests im PR + {files} (Namenskonvention)', { files })
    + (failed > 0 ? ' · ' + t('{n} nicht ladbar', { n: failed }) : '');
}

/** Warnings about the selection: the limit cut it, or the repository's file list was incomplete; empty when none. */
export function basisWarnings(related: RelatedTests | null | undefined): string[] {
  if (!related) {
    return [];
  }
  const result: string[] = [];
  if (related.truncated) {
    result.push(t('Limit erreicht: {n} von {total} passenden Testdateien geladen – weitere bestehende Tests fehlen',
      { n: related.files.length, total: related.candidates }));
  }
  if (related.listIncomplete) {
    result.push(t('Dateiliste des Repositorys unvollständig – passende bestehende Tests können fehlen'));
  }
  return result;
}

/** A chip for an existing test reaching a function: name, file:line and a tooltip (no navigation, not in the diff). */
export interface ExistingChip {
  id: string;
  name: string;
  where: string;
  title: string;
  /** HTTP-Tests: it reaches the function over a real HTTP request */
  http: boolean;
}

export function existingChip(test: ExistingTest, segmentId: string): ExistingChip {
  const file = test.path.substring(test.path.lastIndexOf('/') + 1);
  const direct = test.covers.find((c) => c.segmentId === segmentId)?.direct ?? false;
  const http = httpCover(test.covers, segmentId);
  return {
    id: test.id,
    name: test.name,
    where: `${file}:${test.line}`,
    title: t('Bestehender Test, nicht im PR: {where}', { where: `${test.path}:${test.line}` })
      + ` · ${direct ? t('ruft die Funktion direkt auf') : t('erreicht sie über anderen geänderten Code')}`
      + (http ? ` · ${httpTitle(http)}` : '')
      + ` · ${t('geladen wegen: {reason}', { reason: reasonLabel(test.reason) })}`,
    http: !!http,
  };
}
