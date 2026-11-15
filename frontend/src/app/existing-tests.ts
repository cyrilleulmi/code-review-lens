import { ExistingTest, RelatedReason, RelatedTests } from './api';
import { httpCover, httpTitle } from './http-tests';

/** Why an existing test file was loaded, in words (tooltip). */
export function reasonLabel(reason: RelatedReason): string {
  switch (reason) {
    case 'mirror':
      return 'Namenskonvention: Testdatei der geänderten Datei, im gespiegelten Testordner oder daneben';
    case 'name':
      return 'Namenskonvention: Testdatei gleichen Namens an anderem Ort (die nächstgelegene)';
    case 'prefix':
      return 'Name beginnt mit dem Namen der geänderten Datei, im gespiegelten Testordner';
  }
}

/** The basis of the coverage: changed tests plus the existing test files loaded for the change. */
export function basisText(related: RelatedTests | null | undefined): string {
  if (!related) {
    return 'Grundlage: geänderte Tests im PR';
  }
  const loaded = related.files.filter((f) => f.loaded).length;
  const failed = related.files.length - loaded;
  if (related.files.length === 0) {
    return 'Grundlage: geänderte Tests im PR · keine bestehende Testdatei nach Namenskonvention gefunden';
  }
  const files = loaded === 1 ? '1 nachgeladene Testdatei' : `${loaded} nachgeladene Testdateien`;
  return `Grundlage: geänderte Tests im PR + ${files} (Namenskonvention)` + (failed > 0 ? ` · ${failed} nicht ladbar` : '');
}

/** Warnings about the selection: the limit cut it, or the repository's file list was incomplete; empty when none. */
export function basisWarnings(related: RelatedTests | null | undefined): string[] {
  if (!related) {
    return [];
  }
  const result: string[] = [];
  if (related.truncated) {
    result.push(`Limit erreicht: ${related.files.length} von ${related.candidates} passenden Testdateien geladen – weitere bestehende Tests fehlen`);
  }
  if (related.listIncomplete) {
    result.push('Dateiliste des Repositorys unvollständig – passende bestehende Tests können fehlen');
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
    title: `Bestehender Test, nicht im PR: ${test.path}:${test.line}`
      + ` · ${direct ? 'ruft die Funktion direkt auf' : 'erreicht sie über anderen geänderten Code'}`
      + (http ? ` · ${httpTitle(http)}` : '')
      + ` · geladen wegen: ${reasonLabel(test.reason)}`,
    http: !!http,
  };
}
