/**
 * Übergreifende Ansichten & Informationen: what can be said about a pull request as a whole - its size and spread
 * (metrics), where a second look pays off (hotspots), how its layers depend on each other (layer matrix), which flows
 * share which components (flow matrix), and fitness functions: checks with a limit that say ok, warning or violated.
 *
 * All of it is computed from the analysis the backend delivers - deterministic, no AI, nothing is stored. The limits
 * of the fitness functions are FITNESS_LIMITS.
 */
import { Commit, Component, ComponentEdge, ReviewBundle, Segment } from './api';
import { serverText, t } from './i18n';
import { AREA_IDS, areaOfSegment } from './look';

/** A view across the whole pull request, listed in the tree under "Übergreifende Ansichten & Informationen". */
export interface Insight {
  id: string;
  label: string;
  icon: string;
  /** what it shows and what for */
  tip: string;
}

/** The name of the section of the tree that holds them (and the overview). */
const SECTION = { label: 'Übergreifende Ansichten & Informationen' };
export const INSIGHTS_LABEL = SECTION.label;

export const INSIGHTS: readonly Insight[] = [
  { id: 'components', label: 'Komponenten', icon: 'component', tip: 'Die geänderten Komponenten nach Schicht mit ihren Aufrufbeziehungen; ein Datenfluss lässt sich darin abspielen' },
  { id: 'metrics', label: 'Kennzahlen', icon: 'chart', tip: 'Grösse und Verteilung der Änderung: Zeilen, Blöcke, Flüsse, Anteil Tests, Verteilung auf Schichten, Sprachen und Kategorien' },
  { id: 'fitness', label: 'Fitness-Funktionen', icon: 'gauge', tip: 'Prüfungen mit Grenzwert: Grösse, Schichtrichtung, Zyklen, getestete Änderungen, Kopplung – erfüllt, Hinweis oder verletzt' },
  { id: 'dependencies', label: 'Abhängigkeits-Matrix', icon: 'grid', tip: 'Welche Schicht welche aufruft, mit Aufrufen gegen die erwartete Richtung und Zyklen zwischen Komponenten' },
  { id: 'hotspots', label: 'Hotspots', icon: 'flame', tip: 'Dateien, bei denen ein zweiter Blick lohnt: viel geänderte Logik, viele Verzweigungen, in mehreren Flüssen, ohne Test' },
  { id: 'map', label: 'Änderungs-Karte', icon: 'map', tip: 'Alle geänderten Dateien als Flächen: Grösse = geänderte Zeilen, gruppiert nach Schicht, mit Review-Fortschritt' },
  { id: 'flow-matrix', label: 'Flüsse × Komponenten', icon: 'matrix', tip: 'Welcher Datenfluss durch welche Komponente läuft: geteilte Komponenten koppeln Flüsse aneinander' },
];

// ------------------------------------------------------------------ layers

/** Rank of a layer from the outside in (tests first): calls are expected to run from a lower to a higher rank. */
export function layerRank(area: string): number {
  if (area === 'test') {
    return -1;
  }
  const i = AREA_IDS.indexOf(area);
  return i < 0 ? AREA_IDS.length : i;
}

const byRank = (a: string, b: string) => layerRank(a) - layerRank(b) || a.localeCompare(b);

// ------------------------------------------------------------------ metrics

export interface Share {
  /** id of the layer, language or category ('' = none) */
  id: string;
  value: number;
}

export interface PrMetrics {
  files: number;
  additions: number;
  deletions: number;
  /** blocks of the analysis (segments), and those that are functions or methods */
  blocks: number;
  functions: number;
  flows: number;
  /** steps of the longest flow */
  longestFlow: number;
  components: number;
  /** layers with a changed component */
  layers: number;
  /** changed lines in tests, and their share of all changed lines of the blocks (0..1) */
  testLines: number;
  testShare: number;
  /** changed lines per layer ('' = none), per language of the files, per category - each largest first */
  byArea: Share[];
  byLanguage: Share[];
  byCategory: Share[];
}

function shares(counts: Map<string, number>): Share[] {
  return [...counts].filter(([, value]) => value > 0).map(([id, value]) => ({ id, value })).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
}

function areaMap(components: readonly Component[]): Map<string, string> {
  const map = new Map<string, string>();
  components.forEach((c) => c.segmentIds.forEach((id) => map.set(id, c.area)));
  return map;
}

export function prMetrics(b: Pick<ReviewBundle, 'files' | 'analysis'>): PrMetrics {
  const a = b.analysis;
  const areas = areaMap(a.components);
  const byArea = new Map<string, number>();
  const byCategory = new Map<string, number>();
  let lines = 0;
  let testLines = 0;
  for (const s of a.segments) {
    const n = s.lineKeys.length;
    const area = areaOfSegment(s, areas) ?? '';
    byArea.set(area, (byArea.get(area) ?? 0) + n);
    byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + n);
    lines += n;
    testLines += area === 'test' ? n : 0;
  }
  const byLanguage = new Map<string, number>();
  for (const f of b.files) {
    byLanguage.set(f.language ?? '', (byLanguage.get(f.language ?? '') ?? 0) + f.additions + f.deletions);
  }
  return {
    files: b.files.length,
    additions: b.files.reduce((n, f) => n + f.additions, 0),
    deletions: b.files.reduce((n, f) => n + f.deletions, 0),
    blocks: a.segments.length,
    functions: a.segments.filter((s) => s.symbolKind === 'method' || s.symbolKind === 'function').length,
    flows: a.flows.length,
    longestFlow: Math.max(0, ...a.flows.map((f) => f.steps.length)),
    components: a.components.length,
    layers: new Set(a.components.map((c) => c.area)).size,
    testLines,
    testShare: lines ? testLines / lines : 0,
    byArea: shares(byArea),
    byLanguage: shares(byLanguage),
    byCategory: shares(byCategory),
  };
}

// ------------------------------------------------------------------ dependencies between layers

export interface LayerViolation {
  from: string;
  to: string;
  fromArea: string;
  toArea: string;
  calls: number;
}

export interface LayerMatrix {
  /** the layers with a component, from the outside in */
  areas: string[];
  /** cells[i][j]: calls from a component of layer i to one of layer j */
  cells: number[][];
  /** the largest cell, for the tint */
  max: number;
  /** connections against the expected direction (from an inner layer to an outer one, or into the tests) */
  violations: LayerViolation[];
}

/** A connection counts at least once, also when the analysis has no number of calls for it. */
const weight = (e: ComponentEdge) => Math.max(1, e.calls);

export function layerMatrix(components: readonly Component[], edges: readonly ComponentEdge[]): LayerMatrix {
  const byId = new Map(components.map((c) => [c.id, c]));
  const areas = [...new Set(components.map((c) => c.area))].sort(byRank);
  const index = new Map(areas.map((a, i) => [a, i]));
  const cells = areas.map(() => areas.map(() => 0));
  const violations: LayerViolation[] = [];
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      continue;
    }
    cells[index.get(from.area)!][index.get(to.area)!] += weight(e);
    if (layerRank(to.area) < layerRank(from.area)) {
      violations.push({ from: from.name, to: to.name, fromArea: from.area, toArea: to.area, calls: weight(e) });
    }
  }
  violations.sort((x, y) => y.calls - x.calls || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  return { areas, cells, max: Math.max(0, ...cells.flat()), violations };
}

/** Does the cell (from layer i to layer j of a layer matrix) run against the expected direction? */
export function againstDirection(fromArea: string, toArea: string): boolean {
  return layerRank(toArea) < layerRank(fromArea);
}

/**
 * Cycles between components: groups of two or more components that reach each other (strongly connected components
 * of the call graph), each as the names of its components in alphabetical order; the largest group first.
 */
export function componentCycles(components: readonly Component[], edges: readonly ComponentEdge[]): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from !== e.to) {
      next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    }
  }
  const name = new Map(components.map((c) => [c.id, c.name]));
  // Tarjan, iterative: deep call graphs (a whole repository) must not overflow the stack
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;
  for (const root of components.map((c) => c.id)) {
    if (index.has(root)) {
      continue;
    }
    const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const targets = next.get(frame.id) ?? [];
      if (frame.i < targets.length) {
        const to = targets[frame.i++];
        if (!name.has(to)) {
          continue;
        }
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter++);
          stack.push(to);
          onStack.add(to);
          work.push({ id: to, i: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].id;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const group: string[] = [];
        let id: string;
        do {
          id = stack.pop()!;
          onStack.delete(id);
          group.push(name.get(id)!);
        } while (id !== frame.id);
        if (group.length > 1) {
          groups.push(group.sort((x, y) => x.localeCompare(y)));
        }
      }
    }
  }
  return groups.sort((x, y) => y.length - x.length || x[0].localeCompare(y[0]));
}

// ------------------------------------------------------------------ hotspots

export interface Hotspot {
  path: string;
  /** layer of most of its changed lines; null = none */
  area: string | null;
  /** changed lines of the file (added and removed) */
  lines: number;
  /** its changed functions the coverage knows (testable ones), their decision points, and those no test reaches */
  functions: number;
  branches: number;
  untested: number;
  /** data flows with a step in the file, commits that changed it (0 while the commits are not loaded) */
  flows: number;
  commits: number;
  /** risk × (1 + flows) × (1 + untested), risk = Σ changed lines × (1 + decision points) of its functions */
  score: number;
}

/**
 * The files that deserve a second look, highest score first. Only files with changed functions the coverage lists
 * (testable logic) take part: lock files, translations and styles have a size but no risk of this kind.
 */
export function hotspots(b: Pick<ReviewBundle, 'files' | 'analysis'>, commits: readonly Commit[] = []): Hotspot[] {
  const a = b.analysis;
  const segs = new Map(a.segments.map((s) => [s.id, s]));
  const areas = areaMap(a.components);
  const flowsOf = new Map<string, Set<string>>();
  for (const f of a.flows) {
    for (const step of f.steps) {
      const path = segs.get(step.segmentId)?.path;
      if (path) {
        flowsOf.set(path, (flowsOf.get(path) ?? new Set()).add(f.id));
      }
    }
  }
  const stats = new Map<string, { functions: number; branches: number; untested: number; risk: number }>();
  for (const c of a.coverage ?? []) {
    const path = segs.get(c.segmentId)?.path;
    if (!path) {
      continue;
    }
    const s = stats.get(path) ?? { functions: 0, branches: 0, untested: 0, risk: 0 };
    s.functions++;
    s.branches += c.branches;
    s.untested += c.status === 'none' ? 1 : 0;
    s.risk += c.changedLines * (1 + c.branches);
    stats.set(path, s);
  }
  const result: Hotspot[] = [];
  for (const f of b.files) {
    const s = stats.get(f.path);
    if (!s) {
      continue;
    }
    const flows = flowsOf.get(f.path)?.size ?? 0;
    result.push({
      path: f.path, area: fileArea(a.segments, f.path, areas), lines: f.additions + f.deletions,
      functions: s.functions, branches: s.branches, untested: s.untested, flows,
      commits: commits.filter((c) => c.files.includes(f.path)).length,
      score: s.risk * (1 + flows) * (1 + s.untested),
    });
  }
  return result.sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
}

/** Layer of a file: that of most of its changed lines; null = none of its blocks has one. */
export function fileArea(segments: readonly Segment[], path: string, areas: Map<string, string>): string | null {
  const counts = new Map<string, number>();
  for (const s of segments) {
    const area = s.path === path ? areaOfSegment(s, areas) : null;
    if (area) {
      counts.set(area, (counts.get(area) ?? 0) + Math.max(1, s.lineKeys.length));
    }
  }
  return [...counts].sort((x, y) => y[1] - x[1] || byRank(x[0], y[0]))[0]?.[0] ?? null;
}

// ------------------------------------------------------------------ flows × components

export interface FlowMatrix {
  flows: { id: string; title: string; steps: number }[];
  /** the components a flow runs through, from the outer layers in; flows = how many flows run through it */
  components: { id: string; name: string; area: string; flows: number }[];
  /** cells[flow][component]: steps of the flow in the component */
  cells: number[][];
  /** components more than one flow runs through */
  shared: number;
}

export function flowMatrix(b: Pick<ReviewBundle, 'analysis'>): FlowMatrix {
  const a = b.analysis;
  const componentOf = new Map<string, Component>();
  a.components.forEach((c) => c.segmentIds.forEach((id) => componentOf.set(id, c)));
  const counts = a.flows.map((f) => {
    const row = new Map<string, number>();
    for (const step of f.steps) {
      const c = componentOf.get(step.segmentId);
      if (c) {
        row.set(c.id, (row.get(c.id) ?? 0) + 1);
      }
    }
    return row;
  });
  const components = a.components
    .map((c) => ({ id: c.id, name: c.name, area: c.area, flows: counts.filter((row) => row.has(c.id)).length }))
    .filter((c) => c.flows > 0)
    .sort((x, y) => byRank(x.area, y.area) || x.name.localeCompare(y.name));
  return {
    flows: a.flows.map((f) => ({ id: f.id, title: f.title, steps: f.steps.length })),
    components,
    cells: counts.map((row) => components.map((c) => row.get(c.id) ?? 0)),
    shared: components.filter((c) => c.flows > 1).length,
  };
}

// ------------------------------------------------------------------ fitness functions

export type FitnessStatus = 'ok' | 'warn' | 'fail' | 'na';

export interface FitnessResult {
  id: string;
  label: string;
  /** what is checked and why */
  tip: string;
  status: FitnessStatus;
  /** what was measured, and the limit it is held against (texts in the language of the UI) */
  value: string;
  limit: string;
  /** what caused a warning or violation, one line each (at most FITNESS_LIMITS.details, then «+n weitere») */
  details: string[];
  /** id of the view (INSIGHTS, or 'coverage') that shows more; null = none */
  more: string | null;
}

/** The limits of the fitness functions: up to `ok` it is fine, up to `warn` a hint, beyond that violated. */
export const FITNESS_LIMITS = {
  /** changed lines of the pull request (added + removed): reviews find most up to a few hundred lines */
  size: { ok: 400, warn: 1000 },
  /** changed lines of one file */
  fileSize: { ok: 300, warn: 600 },
  /** share of the changed, testable functions a test reaches */
  tested: { ok: 0.8, warn: 0.5 },
  /** components one component calls */
  fanOut: { ok: 5, warn: 8 },
  /** steps of one data flow */
  flowLength: { ok: 10, warn: 15 },
  /** lines of detail listed per function */
  details: 6,
};

function byLimit(value: number, limit: { ok: number; warn: number }): FitnessStatus {
  return value <= limit.ok ? 'ok' : value <= limit.warn ? 'warn' : 'fail';
}

function listed(lines: string[]): string[] {
  const max = FITNESS_LIMITS.details;
  return lines.length > max ? [...lines.slice(0, max), t('+{n} weitere', { n: lines.length - max })] : lines;
}

/** The fitness functions of a pull request, in a fixed order. */
export function fitness(b: Pick<ReviewBundle, 'files' | 'analysis'>): FitnessResult[] {
  const a = b.analysis;
  const L = FITNESS_LIMITS;
  const results: FitnessResult[] = [];
  const upTo = (limit: { ok: number; warn: number }) => t('bis {ok} gut, bis {warn} Hinweis', limit);

  // size of the pull request
  const lines = b.files.reduce((n, f) => n + f.additions + f.deletions, 0);
  results.push({
    id: 'size', label: 'Grösse des Pull Requests', tip: 'Geänderte Zeilen (neu und entfernt). Kleine Pull Requests werden gründlicher geprüft: Ab einigen hundert Zeilen sinkt die Zahl der gefundenen Fehler pro Zeile deutlich',
    status: byLimit(lines, L.size), value: t('{n} geänderte Zeilen in {files} Dateien', { n: lines, files: b.files.length }), limit: upTo(L.size),
    details: [], more: 'metrics',
  });

  // largest file
  const large = b.files.map((f) => ({ path: f.path, lines: f.additions + f.deletions })).filter((f) => f.lines > L.fileSize.ok).sort((x, y) => y.lines - x.lines);
  const largest = Math.max(0, ...b.files.map((f) => f.additions + f.deletions));
  results.push({
    id: 'file-size', label: 'Grösste Datei', tip: 'Geänderte Zeilen der grössten Datei. Eine sehr grosse Änderung an einer Datei ist schwer am Stück zu prüfen; generierte Dateien und Lockfiles dürfen gross sein',
    status: byLimit(largest, L.fileSize), value: t('{n} Zeilen', { n: largest }), limit: upTo(L.fileSize),
    details: listed(large.map((f) => t('{path}: {n} Zeilen', { path: f.path, n: f.lines }))), more: 'map',
  });

  // direction of the layers
  const matrix = layerMatrix(a.components, a.componentEdges);
  results.push({
    id: 'layers', label: 'Richtung der Schichten', tip: 'Aufrufe laufen von aussen nach innen (Frontend → API → Logik → Daten → Domäne); niemand ruft Tests auf. Ein Aufruf zurück nach aussen koppelt die innere Schicht an die äussere. Die Schicht einer Komponente ist aus Pfad und Inhalt geschätzt: ein Hinweis, kein Beweis',
    status: a.components.length === 0 ? 'na' : matrix.violations.length === 0 ? 'ok' : 'warn',
    value: matrix.violations.length === 1 ? t('1 Verbindung gegen die Richtung') : t('{n} Verbindungen gegen die Richtung', { n: matrix.violations.length }),
    limit: t('keine'),
    details: listed(matrix.violations.map((v) => `${v.from} → ${v.to}`)), more: 'dependencies',
  });

  // cycles
  const cycles = componentCycles(a.components, a.componentEdges);
  results.push({
    id: 'cycles', label: 'Keine Zyklen zwischen Komponenten', tip: 'Komponenten, die sich gegenseitig (direkt oder über andere) aufrufen, lassen sich nur gemeinsam verstehen, testen und ändern',
    status: a.components.length === 0 ? 'na' : cycles.length === 0 ? 'ok' : 'fail',
    value: cycles.length === 1 ? t('1 Zyklus') : t('{n} Zyklen', { n: cycles.length }), limit: t('keine'),
    details: listed(cycles.map((c) => c.join(' ↔ '))), more: 'dependencies',
  });

  // fan-out
  const byId = new Map(a.components.map((c) => [c.id, c.name]));
  const out = new Map<string, Set<string>>();
  for (const e of a.componentEdges) {
    if (e.from !== e.to && byId.has(e.from) && byId.has(e.to)) {
      out.set(e.from, (out.get(e.from) ?? new Set()).add(e.to));
    }
  }
  const fans = [...out].map(([id, to]) => ({ name: byId.get(id)!, n: to.size })).sort((x, y) => y.n - x.n || x.name.localeCompare(y.name));
  const fanMax = fans[0]?.n ?? 0;
  results.push({
    id: 'fan-out', label: 'Kopplung einer Komponente', tip: 'Wie viele andere geänderte Komponenten eine Komponente aufruft. Wer viele aufruft, weiss viel und bricht bei vielen Änderungen',
    status: a.components.length === 0 ? 'na' : byLimit(fanMax, L.fanOut),
    value: fans.length ? t('{name} ruft {n} Komponenten auf', { name: fans[0].name, n: fanMax }) : t('keine Aufrufe zwischen Komponenten'), limit: upTo(L.fanOut),
    details: listed(fans.filter((f) => f.n > L.fanOut.ok).map((f) => t('{name}: {n} Komponenten', f))), more: 'components',
  });

  // flow length
  const long = a.flows.filter((f) => f.steps.length > L.flowLength.ok).sort((x, y) => y.steps.length - x.steps.length);
  const longest = Math.max(0, ...a.flows.map((f) => f.steps.length));
  results.push({
    id: 'flow-length', label: 'Länge der Datenflüsse', tip: 'Schritte des längsten Datenflusses. Ein sehr langer Fluss ändert an vielen Stellen zugleich und ist schwer am Stück nachzuvollziehen',
    status: a.flows.length === 0 ? 'na' : byLimit(longest, L.flowLength),
    value: a.flows.length ? t('längster Fluss: {n} Schritte', { n: longest }) : t('keine Datenflüsse'), limit: upTo(L.flowLength),
    details: listed(long.map((f) => t('{title}: {n} Schritte', { title: serverText(f.title), n: f.steps.length }))), more: 'flow-matrix',
  });

  // tested change
  const coverage = a.coverage ?? [];
  const segs = new Map(a.segments.map((s) => [s.id, s]));
  const untested = coverage.filter((c) => c.status === 'none').sort((x, y) => y.risk - x.risk);
  const share = coverage.length ? (coverage.length - untested.length) / coverage.length : 1;
  results.push({
    id: 'tested', label: 'Geänderte Funktionen mit Test', tip: 'Anteil der geänderten, testbaren Funktionen, die ein Test erreicht (direkt, indirekt oder ein bestehender Test) – statisch ermittelt, gemockte Aufrufe zählen nicht',
    status: coverage.length === 0 ? 'na' : share >= L.tested.ok ? 'ok' : share >= L.tested.warn ? 'warn' : 'fail',
    value: coverage.length ? t('{n} von {total} Funktionen ({percent} %)', { n: coverage.length - untested.length, total: coverage.length, percent: Math.round(share * 100) }) : t('keine testbaren Funktionen geändert'),
    limit: t('ab {ok} % gut, ab {warn} % Hinweis', { ok: Math.round(L.tested.ok * 100), warn: Math.round(L.tested.warn * 100) }),
    details: listed(untested.map((c) => segs.get(c.segmentId)?.symbol ?? segs.get(c.segmentId)?.path ?? c.segmentId)), more: 'coverage',
  });

  // tests that mock what the pull request changes
  const mocks = a.mockWarnings ?? [];
  results.push({
    id: 'mocks', label: 'Keine Tests, die Geändertes mocken', tip: 'Ein Test, der eine geänderte Funktion durch einen Mock ersetzt, hält das alte Verhalten fest und merkt nicht, wenn das neue falsch ist',
    status: a.mockWarnings == null ? 'na' : mocks.length === 0 ? 'ok' : 'warn',
    value: mocks.length === 1 ? t('1 Test mockt geänderten Code') : t('{n} Tests mocken geänderten Code', { n: mocks.length }), limit: t('keine'),
    details: listed(mocks.map((m) => `${m.testName} → ${m.collaborator}.${m.member}`)), more: 'coverage',
  });

  // expectation rules
  const checks = a.ruleChecks ?? [];
  const unmet = checks.filter((c) => !c.met);
  results.push({
    id: 'rules', label: 'Erwartungs-Regeln erfüllt', tip: 'Regeln der Art «Zugriffsprüfung geändert → Test für verweigerten Zugriff»: zu jeder Änderung, die eine Regel auslöst, gibt es einen Test der erwarteten Form',
    status: checks.length === 0 ? 'na' : unmet.length === 0 ? 'ok' : 'warn',
    value: checks.length ? t('{n} von {total} erfüllt', { n: checks.length - unmet.length, total: checks.length }) : t('keine Regel ausgelöst'), limit: t('alle'),
    details: listed(unmet.map((c) => serverText(c.label))), more: 'coverage',
  });

  return results;
}

/** How many fitness functions are ok, warn and fail (those that do not apply are left out). */
export function fitnessSummary(results: readonly FitnessResult[]): { ok: number; warn: number; fail: number } {
  const count = (status: FitnessStatus) => results.filter((r) => r.status === status).length;
  return { ok: count('ok'), warn: count('warn'), fail: count('fail') };
}
