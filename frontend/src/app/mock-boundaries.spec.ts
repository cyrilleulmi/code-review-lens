import { describe, expect, it } from 'vitest';
import { Analysis, FlowCoverage, MockWarning, Segment } from './api';
import { edgeTitle, flowRuns, groupWarnings, lineOwner, mockBadgeTitle, nameList, stepTitle, testNamer } from './mock-boundaries';

const warning: MockWarning = {
  test: 's71', testName: 'stubbed › hands the number to the API', path: 'src/app/player-view.spec.ts', line: 302,
  segmentId: 's44', member: 'setJerseyNumber', collaborator: 'PlayerApiService',
};

const coverage: FlowCoverage = {
  flowId: 'flow-1',
  steps: [
    { segmentId: 's44', status: 'tested', tests: ['s62'], mockedBy: ['s71', 'e1'] },
    { segmentId: 's3', status: 'mocked', tests: [], mockedBy: ['s28'] },
  ],
  edges: [
    { from: 's73', to: 's44', status: 'tested', tests: ['s62'] },
    { from: 's44', to: 's3', status: 'separate', tests: [] },
  ],
};

const names = testNamer({
  tests: [{ segmentId: 's62', name: 'saves' }, { segmentId: 's71', name: 'stubbed' }],
  existingTests: [{ id: 'e1', name: 'old one' }],
} as unknown as Analysis);

describe('Mock-Grenzen', () => {
  it('names changed and existing tests, unknown ids stay', () => {
    expect(names('s62')).toBe('saves');
    expect(names('e1')).toBe('old one');
    expect(names('s99')).toBe('s99');
    expect(nameList(['a'])).toBe('a');
    expect(nameList(['a', 'b'])).toBe('a und b');
    expect(nameList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c und 2 weitere');
  });

  it('describes a step: real runs, mocks and warnings', () => {
    const runs = flowRuns(coverage);
    const title = stepTitle(runs.steps.get('s44'), names, [warning]);
    expect(title).toContain('echt getestet');
    expect(title).toContain('echt ausgeführt von saves');
    expect(title).toContain('gemockt in stubbed und old one');
    expect(title).toContain('PlayerApiService.setJerseyNumber');
    expect(stepTitle(runs.steps.get('s3'), names)).toContain('nur gemockt');
    expect(stepTitle(undefined, names)).toBe('');
  });

  it('describes an edge by status', () => {
    const runs = flowRuns(coverage);
    expect(edgeTitle(runs.edges.get('s73>s44'), names)).toBe('von einem Test durchlaufen: saves');
    expect(edgeTitle(runs.edges.get('s44>s3'), names)).toContain('nur einzeln getestet');
    expect(flowRuns(null).steps.size).toBe(0);
  });

  it('groups warnings by mocked segment and by test', () => {
    const other = { ...warning, test: 'e2', segmentId: 's45', member: 'clearJerseyNumber' };
    expect(groupWarnings([warning, other], 'segmentId').get('s45')).toEqual([other]);
    expect(groupWarnings([warning, other], 'test').get('s71')).toEqual([warning]);
    expect(groupWarnings(null, 'test').size).toBe(0);
    expect(mockBadgeTitle([warning, warning])).toContain('PlayerApiService.setJerseyNumber –');
  });

  it('finds the block that shows the stub line: the innermost symbol around it', () => {
    const seg = (id: string, startLine: number, endLine: number, path = 'a.spec.ts') => ({ id, path, startLine, endLine }) as Segment;
    const segments = [seg('file', 1, 400), seg('suite', 290, 330), seg('test', 309, 320), seg('other', 1, 999, 'b.ts')];
    expect(lineOwner(segments, 'a.spec.ts', 302, 'test')).toBe('suite');
    expect(lineOwner(segments, 'a.spec.ts', 315, 'x')).toBe('test');
    expect(lineOwner(segments, 'a.spec.ts', null, 'test')).toBe('test');
    expect(lineOwner([], 'a.spec.ts', 3, 'test')).toBe('test');
  });
});
