import type { ReloadInfo } from './api';

/** What a reload did: no new commits, or how many marks moved along and how much is new since the review. */
export function reloadMessage(previousHead: string | undefined, headSha: string, reload: ReloadInfo | null | undefined): string {
  if (previousHead === headSha) {
    return 'Neu geladen: keine neuen Commits';
  }
  if (!reload || reload.toHeadSha !== headSha) {
    return 'Snapshot neu geladen und analysiert';
  }
  const fresh = Object.values(reload.newLines ?? {}).reduce((n, keys) => n + keys.length, 0);
  const lost = reload.dropped ? `, ${reload.dropped} verworfen (Zeile geändert)` : '';
  return `Neue Commits: ${reload.kept} Markierungen übernommen${lost} · `
    + `${fresh} Zeilen neu oder geändert seit ${reload.fromHeadSha.substring(0, 7)}`;
}
