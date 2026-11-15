import { AffectedTest, SetupImpact, SetupImpactKind } from './api';

/**
 * Wirkung von Setup und Testdaten: pure helpers for the notices in the spec overview, the marker on unchanged but
 * affected tests in the outline, the header badge of the changed setup block / fixture / helper and the tests tile.
 */

export const KIND_LABELS: Record<SetupImpactKind, string> = {
  setup: 'Setup geändert',
  fixture: 'Testdaten geändert',
  helper: 'Testhilfe geändert',
};

const STATUS_LABELS: Record<AffectedTest['status'], string> = {
  added: 'neu',
  changed: 'geändert',
  renamed: 'umbenannt',
  unchanged: 'unverändert',
};

function tests(n: number): string {
  return n === 1 ? '1 Test' : `${n} Tests`;
}

/** Warning styling only when the change reaches tests the PR does not touch. */
export function impactWarns(i: { unchangedCount: number }): boolean {
  return i.unchangedCount > 0;
}

/** «Testdaten geändert: CARMELA wirkt auf 12 Tests, davon 10 unverändert» (notice in the spec overview). */
export function impactNotice(i: SetupImpact): string {
  const rest = i.unchangedCount > 0 ? `, davon ${i.unchangedCount} unverändert` : ' (alle neu oder geändert)';
  return `${KIND_LABELS[i.kind]}: ${i.name} wirkt auf ${tests(i.affected.length)}${rest}`;
}

/** The distinct tests of several impacts (one segment can hold several fixtures), in order of appearance. */
export function distinctAffected(impacts: SetupImpact[]): AffectedTest[] {
  const seen = new Set<string>();
  const result: AffectedTest[] = [];
  for (const i of impacts) {
    for (const t of i.affected) {
      const key = `${t.path}#${t.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(t);
      }
    }
  }
  return result;
}

/** Header badge of the changed piece: «wirkt auf 12 Tests (10 unverändert)»; null without impacts. */
export function impactBadge(impacts: SetupImpact[] | undefined | null): { text: string; title: string; warn: boolean } | null {
  if (!impacts?.length) return null;
  const affected = distinctAffected(impacts);
  const unchanged = affected.filter((t) => t.status === 'unchanged').length;
  const text = `wirkt auf ${tests(affected.length)}${unchanged > 0 ? ` (${unchanged} unverändert)` : ''}`;
  const head = impacts.map((i) => `${KIND_LABELS[i.kind]}: ${i.name}`).join('\n');
  return { text, title: `${head}\n${affectedList(affected)}\n– Statisch über Namen und Geltungsbereich erkannt (Wirkung von Setup und Testdaten)`, warn: unchanged > 0 };
}

/** One line per affected test: «· PlayerView › shows it (unverändert) – player-view.spec.ts:68». */
export function affectedList(affected: AffectedTest[]): string {
  return affected.map((t) => `· ${t.name} (${affectedStatus(t)}) – ${fileOf(t.path)}:${t.line}`).join('\n');
}

/** «unverändert», «neu», …; tests of existing files: «unverändert, bestehende Datei». */
export function affectedStatus(t: AffectedTest): string {
  return t.existing ? 'unverändert, bestehende Datei' : STATUS_LABELS[t.status];
}

/** Impacts reaching unchanged tests first (most such tests first), then the others in their order. */
export function sortImpacts(impacts: SetupImpact[]): SetupImpact[] {
  return [...impacts].sort((a, b) => Number(impactWarns(b)) - Number(impactWarns(a)) || (impactWarns(a) ? b.unchangedCount - a.unchangedCount : 0));
}

/** Unchanged tests reached by some impact: path -> start line -> the impacts (marker in the outline). */
export function unchangedAffected(impacts: SetupImpact[] | undefined | null): Map<string, Map<number, SetupImpact[]>> {
  const result = new Map<string, Map<number, SetupImpact[]>>();
  for (const i of impacts ?? []) {
    for (const t of i.affected) {
      if (t.status !== 'unchanged') continue;
      let byLine = result.get(t.path);
      if (!byLine) {
        byLine = new Map();
        result.set(t.path, byLine);
      }
      const list = byLine.get(t.line) ?? [];
      if (!list.includes(i)) byLine.set(t.line, [...list, i]);
    }
  }
  return result;
}

/** How many distinct unchanged tests (changed test files and existing ones) some setup change reaches. */
export function countUnchangedAffected(impacts: SetupImpact[] | undefined | null): number {
  let n = 0;
  for (const byLine of unchangedAffected(impacts).values()) n += byLine.size;
  return n;
}

/** Tooltip of the outline marker «Setup geändert» on an unchanged test. */
export function markerTitle(impacts: SetupImpact[]): string {
  return impacts.map((i) => `${KIND_LABELS[i.kind]}: ${i.name}`).join('\n')
    + '\nDer Test ist im PR unverändert, aber sein Setup bzw. seine Testdaten sind es nicht – er prüft jetzt vielleicht etwas anderes.';
}

/** «3 unveränderte, aber betroffen»; null when none. */
export function unchangedAffectedText(n: number): string | null {
  return n > 0 ? `${n} unveränderte, aber betroffen` : null;
}

/** Tests tile of the overview: «Setup/Testdaten geändert: wirkt auf 3 unveränderte Tests»; null when none. */
export function setupTileText(n: number): string | null {
  if (n <= 0) return null;
  return `Setup/Testdaten geändert: wirkt auf ${n === 1 ? '1 unveränderten Test' : `${n} unveränderte Tests`}`;
}

function fileOf(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}
