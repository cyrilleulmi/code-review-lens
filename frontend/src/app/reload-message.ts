import type { ReloadInfo } from './api';
import { t } from './i18n';

/** What a reload did: no new commits, or how many marks moved along and how much is new since the review. */
export function reloadMessage(previousHead: string | undefined, headSha: string, reload: ReloadInfo | null | undefined): string {
  if (previousHead === headSha) {
    return t('Neu geladen: keine neuen Commits');
  }
  if (!reload || reload.toHeadSha !== headSha) {
    return t('Snapshot neu geladen und analysiert');
  }
  const fresh = Object.values(reload.newLines ?? {}).reduce((n, keys) => n + keys.length, 0);
  const lost = reload.dropped ? t(', {n} verworfen (Zeile geändert)', { n: reload.dropped }) : '';
  return t('Neue Commits: {kept} Markierungen übernommen{lost} · {fresh} Zeilen neu oder geändert seit {sha}', {
    kept: reload.kept, lost, fresh, sha: reload.fromHeadSha.substring(0, 7),
  });
}
