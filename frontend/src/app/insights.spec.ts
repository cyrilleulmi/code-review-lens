import { describe, expect, it } from 'vitest';
import { Analysis, CodeCoverage, Component, ComponentEdge, FileSummary, Flow, ReviewBundle, Segment } from './api';
import {
  FITNESS_LIMITS, INSIGHTS, againstDirection, componentCycles, fileArea, fitness, fitnessSummary, flowMatrix, hotspots, layerMatrix, layerRank, prMetrics,
} from './insights';
import { startSelection } from './start-selection';

const segment = (id: string, path: string, lines: number, more: Partial<Segment> = {}): Segment => ({
  id, path, language: 'typescript', kind: 'symbol', symbol: id, symbolKind: 'method', startLine: 1, endLine: lines, category: 'logic', group: path,
  ruleId: null, reason: '', lineKeys: Array.from({ length: lines }, (_, i) => 'N' + (i + 1)), lines: [], places: [], testedBy: [], layer: null, frontend: false,
  ...more,
});
const file = (path: string, additions: number, deletions = 0, language = 'typescript'): FileSummary =>
  ({ path, previousPath: null, status: 'modified', additions, deletions, language });
const component = (id: string, area: string, segmentIds: string[] = []): Component => ({ id, name: id, paths: [id + '.ts'], area, segmentIds });
const edge = (from: string, to: string, calls = 1): ComponentEdge => ({ from, to, calls, http: false });
const flow = (id: string, ...segmentIds: string[]): Flow =>
  ({ id, title: id, steps: segmentIds.map((segmentId, order) => ({ segmentId, order, depth: order, parentSegmentId: segmentIds[order - 1] ?? null })), edges: [] });
const covered = (segmentId: string, status: CodeCoverage['status'], changedLines = 10, branches = 0): CodeCoverage =>
  ({ segmentId, status, directTests: [], indirectTests: [], branches, changedLines, risk: changedLines * (1 + branches) });

function bundle(analysis: Partial<Analysis>, files: FileSummary[] = []): Pick<ReviewBundle, 'files' | 'analysis'> {
  return {
    files,
    analysis: {
      schemaVersion: 1, generatedAt: '', headSha: '', rulesHash: '', segments: [], categories: [], flows: [], tests: [], architecture: null,
      components: [], componentEdges: [], ...analysis,
    } as Analysis,
  };
}

/** view (frontend) -> api -> service (logic) -> repo (data); a test of the service */
const segments = [
  segment('view.save', 'web/view.ts', 20, { frontend: true }),
  segment('api.update', 'api/resource.java', 30, { language: 'java' }),
  segment('service.apply', 'core/service.java', 40, { language: 'java' }),
  segment('repo.find', 'data/repo.java', 10, { language: 'java' }),
  segment('service.test', 'core/service.test.java', 50, { language: 'java', category: 'tests' }),
];
const components = [
  component('view', 'frontend', ['view.save']), component('resource', 'api', ['api.update']),
  component('service', 'logic', ['service.apply']), component('repo', 'data', ['repo.find']),
];
const edges = [edge('view', 'resource', 1), edge('resource', 'service', 2), edge('service', 'repo', 3)];
const files = [file('web/view.ts', 15, 5), file('api/resource.java', 30, 0, 'java'), file('core/service.java', 35, 5, 'java'),
  file('data/repo.java', 10, 0, 'java'), file('core/service.test.java', 50, 0, 'java')];
const whole = bundle({
  segments, components, componentEdges: edges,
  flows: [flow('flow-1', 'view.save', 'api.update', 'service.apply', 'repo.find'), flow('flow-2', 'api.update', 'service.apply')],
  coverage: [covered('api.update', 'direct', 10, 1), covered('service.apply', 'none', 20, 3), covered('repo.find', 'indirect', 5, 0)],
}, files);

describe('prMetrics', () => {
  const m = prMetrics(whole);

  it('counts what the pull request changes', () => {
    expect(m).toMatchObject({ files: 5, additions: 140, deletions: 10, blocks: 5, functions: 5, flows: 2, longestFlow: 4, components: 4, layers: 4 });
  });

  it('gives the share of the tests among the changed lines', () => {
    expect(m.testLines).toBe(50);
    expect(m.testShare).toBeCloseTo(50 / 150);
  });

  it('spreads the changed lines over layers, languages and categories, largest first', () => {
    expect(m.byArea).toEqual([{ id: 'test', value: 50 }, { id: 'logic', value: 40 }, { id: 'api', value: 30 }, { id: 'frontend', value: 20 }, { id: 'data', value: 10 }]);
    expect(m.byLanguage).toEqual([{ id: 'java', value: 130 }, { id: 'typescript', value: 20 }]);
    expect(m.byCategory).toEqual([{ id: 'logic', value: 100 }, { id: 'tests', value: 50 }]);
  });

  it('is empty for an empty analysis', () => {
    expect(prMetrics(bundle({}))).toMatchObject({ files: 0, blocks: 0, longestFlow: 0, testShare: 0, byArea: [] });
  });
});

describe('layerMatrix', () => {
  it('orders the layers from the outside in, the tests first', () => {
    expect(['domain', 'logic', 'frontend', 'test', 'api'].sort((a, b) => layerRank(a) - layerRank(b))).toEqual(['test', 'frontend', 'api', 'logic', 'domain']);
  });

  it('counts the calls from layer to layer', () => {
    const m = layerMatrix(components, edges);
    expect(m.areas).toEqual(['frontend', 'api', 'logic', 'data']);
    expect(m.cells).toEqual([[0, 1, 0, 0], [0, 0, 2, 0], [0, 0, 0, 3], [0, 0, 0, 0]]);
    expect(m.max).toBe(3);
    expect(m.violations).toEqual([]);
  });

  it('finds the calls against the direction: from an inner layer to an outer one, and into the tests', () => {
    const all = [...components, component('spec', 'test')];
    const m = layerMatrix(all, [...edges, edge('repo', 'resource', 2), edge('service', 'spec'), edge('spec', 'service'), edge('service', 'service')]);
    expect(m.violations).toEqual([
      { from: 'repo', to: 'resource', fromArea: 'data', toArea: 'api', calls: 2 },
      { from: 'service', to: 'spec', fromArea: 'logic', toArea: 'test', calls: 1 },
    ]);
    expect(againstDirection('data', 'api')).toBe(true);
    expect(againstDirection('api', 'data')).toBe(false);
    expect(againstDirection('logic', 'logic')).toBe(false);
  });

  it('counts a connection without a number of calls once, and leaves out unknown components', () => {
    const m = layerMatrix(components, [edge('view', 'resource', 0), edge('view', 'gone')]);
    expect(m.cells[0][1]).toBe(1);
    expect(m.max).toBe(1);
  });
});

describe('componentCycles', () => {
  it('finds no cycle in a chain', () => {
    expect(componentCycles(components, edges)).toEqual([]);
  });

  it('finds components that reach each other, directly and over others', () => {
    const cycles = componentCycles(
      [...components, component('a', 'logic'), component('b', 'logic')],
      [...edges, edge('repo', 'resource'), edge('a', 'b'), edge('b', 'a'), edge('view', 'view')],
    );
    expect(cycles).toEqual([['repo', 'resource', 'service'], ['a', 'b']]);
  });
});

describe('hotspots', () => {
  it('ranks the files with changed functions by risk, flows and missing tests', () => {
    const list = hotspots(whole);
    expect(list.map((h) => h.path)).toEqual(['core/service.java', 'api/resource.java', 'data/repo.java']);
    // risk 20 × (1 + 3) = 80, in two flows, one function without a test
    expect(list[0]).toMatchObject({ area: 'logic', lines: 40, functions: 1, branches: 3, untested: 1, flows: 2, score: 80 * 3 * 2 });
    // risk 10 × (1 + 1) = 20, in two flows, tested
    expect(list[1]).toMatchObject({ area: 'api', untested: 0, flows: 2, score: 20 * 3 });
    expect(list[2]).toMatchObject({ flows: 1, score: 5 * 2 });
  });

  it('leaves out files without testable changed functions, and counts the commits of a file', () => {
    const commit = (sha: string, paths: string[]) => ({ sha, files: paths }) as never;
    const list = hotspots(whole, [commit('a', ['core/service.java']), commit('b', ['core/service.java', 'web/view.ts'])]);
    expect(list.some((h) => h.path === 'web/view.ts' || h.path === 'core/service.test.java')).toBe(false);
    expect(list[0].commits).toBe(2);
    expect(list[1].commits).toBe(0);
  });

  it('gives a file the layer of most of its changed lines', () => {
    const areas = new Map([['a', 'api'], ['b', 'logic']]);
    const mixed = [segment('a', 'x.ts', 5), segment('b', 'x.ts', 9), segment('c', 'y.css', 3)];
    expect(fileArea(mixed, 'x.ts', areas)).toBe('logic');
    expect(fileArea(mixed, 'y.css', areas)).toBeNull();
  });
});

describe('flowMatrix', () => {
  const m = flowMatrix(whole);

  it('counts the steps of every flow per component, components from the outer layers in', () => {
    expect(m.flows).toEqual([{ id: 'flow-1', title: 'flow-1', steps: 4 }, { id: 'flow-2', title: 'flow-2', steps: 2 }]);
    expect(m.components.map((c) => c.name)).toEqual(['view', 'resource', 'service', 'repo']);
    expect(m.cells).toEqual([[1, 1, 1, 1], [0, 1, 1, 0]]);
  });

  it('says which components several flows share', () => {
    expect(m.components.map((c) => c.flows)).toEqual([1, 2, 2, 1]);
    expect(m.shared).toBe(2);
  });

  it('leaves out components no flow runs through', () => {
    const lonely = flowMatrix(bundle({ segments, components: [...components, component('other', 'logic')], flows: [flow('f', 'view.save')] }));
    expect(lonely.components.map((c) => c.name)).toEqual(['view']);
  });
});

describe('fitness', () => {
  const byId = (results: ReturnType<typeof fitness>) => Object.fromEntries(results.map((r) => [r.id, r]));

  it('has the functions in a fixed order, each leading to a view that exists', () => {
    const results = fitness(whole);
    expect(results.map((r) => r.id)).toEqual(['size', 'file-size', 'layers', 'cycles', 'fan-out', 'flow-length', 'tested', 'mocks', 'rules']);
    const views = new Set([...INSIGHTS.map((i) => i.id), 'coverage']);
    expect(results.every((r) => r.more == null || views.has(r.more))).toBe(true);
  });

  it('is content with a small, layered, tested pull request', () => {
    const r = byId(fitness(bundle({ ...whole.analysis, coverage: [covered('api.update', 'direct')], mockWarnings: [], ruleChecks: [] }, files)));
    expect(r['size'].status).toBe('ok');
    expect(r['file-size'].status).toBe('ok');
    expect(r['layers'].status).toBe('ok');
    expect(r['cycles'].status).toBe('ok');
    expect(r['fan-out'].status).toBe('ok');
    expect(r['flow-length'].status).toBe('ok');
    expect(r['tested'].status).toBe('ok');
    expect(r['mocks'].status).toBe('ok');
    // no rule was triggered: nothing to judge
    expect(r['rules'].status).toBe('na');
  });

  it('judges size by the limits', () => {
    const sized = (lines: number) => byId(fitness(bundle({}, [file('a.ts', lines)])));
    expect(sized(FITNESS_LIMITS.size.ok)['size'].status).toBe('ok');
    expect(sized(FITNESS_LIMITS.size.ok + 1)['size'].status).toBe('warn');
    expect(sized(FITNESS_LIMITS.size.warn + 1)['size'].status).toBe('fail');
    expect(sized(FITNESS_LIMITS.fileSize.warn + 1)['file-size']).toMatchObject({ status: 'fail', details: [expect.stringContaining('a.ts')] });
  });

  it('warns about calls against the direction and fails for cycles, naming them', () => {
    const r = byId(fitness(bundle({ components, componentEdges: [...edges, edge('repo', 'resource')] })));
    expect(r['layers']).toMatchObject({ status: 'warn', details: ['repo → resource'] });
    expect(r['cycles']).toMatchObject({ status: 'fail', details: ['repo ↔ resource ↔ service'] });
  });

  it('judges the share of tested functions', () => {
    const tested = (none: number, total: number) => byId(fitness(bundle({
      segments, coverage: Array.from({ length: total }, (_, i) => covered('service.apply', i < none ? 'none' : 'direct')),
    })))['tested'];
    expect(tested(1, 10).status).toBe('ok');
    expect(tested(4, 10).status).toBe('warn');
    expect(tested(6, 10)).toMatchObject({ status: 'fail' });
    expect(tested(6, 10).details).toHaveLength(6);
    expect(tested(9, 10).details).toHaveLength(FITNESS_LIMITS.details + 1);
  });

  it('does not judge what the analysis has nothing about', () => {
    const r = byId(fitness(bundle({})));
    expect(['layers', 'cycles', 'fan-out', 'flow-length', 'tested', 'mocks', 'rules'].map((id) => r[id].status)).toEqual(Array(7).fill('na'));
    expect(fitnessSummary(Object.values(r))).toEqual({ ok: 2, warn: 0, fail: 0 });
  });

  it('counts a component that calls many others, and long flows', () => {
    const many = Array.from({ length: FITNESS_LIMITS.fanOut.ok + 1 }, (_, i) => component('c' + i, 'logic'));
    const hub = byId(fitness(bundle({ components: [component('hub', 'api'), ...many], componentEdges: many.map((c) => edge('hub', c.id)) })));
    expect(hub['fan-out']).toMatchObject({ status: 'warn' });
    const steps = Array.from({ length: FITNESS_LIMITS.flowLength.warn + 1 }, (_, i) => 's' + i);
    expect(byId(fitness(bundle({ flows: [flow('long', ...steps)] })))['flow-length'].status).toBe('fail');
  });
});

describe('startSelection', () => {
  const categories = [
    { id: 'quick-wins', label: '', description: '', icon: '', groups: [{ id: 'quick-wins/dto', label: '', description: null, flowId: null, segmentIds: [] }] },
    { id: 'flows', label: '', description: '', icon: '', view: 'flow', groups: [
      { id: 'flows/flow-2', label: '', description: null, flowId: 'flow-2', segmentIds: [] },
      { id: 'flows/flow-1', label: '', description: null, flowId: 'flow-1', segmentIds: [] },
    ] },
  ];

  it('opens a pull request on its first data flow', () => {
    expect(startSelection(bundle({ categories }) as ReviewBundle)).toEqual({ kind: 'flow', id: 'flow-2' });
  });

  it('opens the overview without flows, and when the flows are switched off', () => {
    expect(startSelection(bundle({ categories: [categories[0]] }) as ReviewBundle)).toEqual({ kind: 'overview' });
    expect(startSelection(bundle({ categories }) as ReviewBundle, new Set(['flows']))).toEqual({ kind: 'overview' });
  });
});
