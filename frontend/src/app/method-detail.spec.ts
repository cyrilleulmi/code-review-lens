import { describe, expect, it } from 'vitest';
import { Signature, TypeInfo } from './api';
import { dataLines, methodText, methodTooltip, signatureLabel, typeLine } from './method-detail';

const signature = (params: [string, string | null][], returns: string | null, types: string[] = []): Signature =>
  ({ declaration: 'as written', params: params.map(([name, type]) => ({ name, type })), returns, types });
const type = (name: string, fields: [string, string | null][], more = 0): TypeInfo =>
  ({ id: 'model.ts#' + name, name, path: 'model.ts', kind: 'interface', line: 1, fields: fields.map(([n, t]) => ({ name: n, type: t })), more });
const known = (...list: TypeInfo[]) => new Map(list.map((t) => [t.id, t]));

const update = signature([['id', 'string'], ['change', 'PlayerUpdate']], 'Observable<PlayerDetail>', ['model.ts#PlayerUpdate', 'model.ts#PlayerDetail']);
const types = known(
  type('PlayerUpdate', [['jerseyNumber', 'number | null']]),
  type('PlayerDetail', [['id', 'string'], ['name', 'string'], ['jerseyNumber', 'number | null']]),
);

describe('signatureLabel', () => {
  it('writes parameters and return type in one notation for every language', () => {
    expect(signatureLabel('update', update)).toBe('update(id: string, change: PlayerUpdate): Observable<PlayerDetail>');
    expect(signatureLabel('load', signature([], null))).toBe('load()');
    // a parameter without a type (JavaScript), one without a name (Go)
    expect(signatureLabel('f', signature([['a', null], ['', 'int']], 'error'))).toBe('f(a, int): error');
  });

  it('leaves out parameters from the end when the line gets too long, then cuts the return type', () => {
    const long = signature([['first', 'FirstParameter'], ['second', 'SecondParameter'], ['third', 'ThirdParameter']], 'Result');
    expect(signatureLabel('handle', long, 70)).toBe('handle(first: FirstParameter, second: SecondParameter, …): Result');
    expect(signatureLabel('handle', long, 60)).toBe('handle(first: FirstParameter, …): Result');
    expect(signatureLabel('handle', long, 44)).toBe('handle(first: FirstParameter, …): Result');
    expect(signatureLabel('handle', long, 20)).toBe('handle(…): Result');
    expect(signatureLabel('handle', signature([['a', 'A']], 'Map<String, List<VeryLongTypeName>>'), 30)).toBe('handle(…): Map<String, List<V…');
    expect(signatureLabel('aVeryLongMethodName', long, 22)).toBe('aVeryLongMethodName(…)');
  });
});

describe('typeLine', () => {
  it('lists the fields of a type', () => {
    expect(typeLine(types.get('model.ts#PlayerDetail')!)).toBe('PlayerDetail { id: string, name: string, jerseyNumber: number | null }');
  });

  it('counts the fields that do not fit, and those the analysis left out', () => {
    const t = type('Player', [['id', 'string'], ['name', 'string'], ['team', 'Team']], 4);
    expect(typeLine(t, 40)).toBe('Player { id: string, name: string, +5 }');
    expect(typeLine(t)).toBe('Player { id: string, name: string, team: Team, +4 }');
    expect(typeLine(type('Wide', [['aVeryLongFieldNameIndeed', 'AVeryLongTypeNameIndeed']]), 30)).toBe('Wide { aVeryLongFieldNameInde…');
  });

  it('lists the constants of an enum and names a type without fields', () => {
    expect(typeLine(type('Position', [['Goalie', null], ['Defender', null]]))).toBe('Position { Goalie, Defender }');
    expect(typeLine(type('Role', []))).toBe('Role');
  });
});

describe('dataLines', () => {
  it('gives a line per type the signature names and the analysis knows', () => {
    expect(dataLines(update, types)).toEqual([
      'PlayerUpdate { jerseyNumber: number | null }',
      'PlayerDetail { id: string, name: string, jerseyNumber: number | null }',
    ]);
    expect(dataLines(signature([['a', 'Unknown']], null, ['other.ts#Unknown']), types)).toEqual([]);
  });

  it('says how many types are left out when there are too many', () => {
    const many = known(type('A', []), type('B', []), type('C', []), type('D', []));
    const s = signature([], null, [...many.keys()]);
    expect(dataLines(s, many)).toEqual(['A', 'B', '+2 …']);
    expect(dataLines(signature([], null, [...many.keys()].slice(0, 3)), many)).toEqual(['A', 'B', 'C']);
  });
});

describe('methodText', () => {
  it('shows the name, the signature, or the signature with its data structures', () => {
    expect(methodText('update', true, update, 'name', types)).toEqual({ label: 'update()', data: [] });
    expect(methodText('update', true, update, 'signature', types)).toEqual({ label: 'update(id: string, change: PlayerUpdate): Observable<PlayerDetail>', data: [] });
    expect(methodText('update', true, update, 'data', types).data).toHaveLength(2);
  });

  it('cuts the texts to the room a diagram has', () => {
    const tight = methodText('update', true, update, 'data', types, { signature: 40, data: 30 });
    expect(tight.label).toBe('update(…): Observable<PlayerDetail>');
    expect(tight.data).toEqual(['PlayerUpdate { jerseyNumber: …', 'PlayerDetail { id: string, +2…']);
    expect(tight.data.every((line) => line.length <= 30)).toBe(true);
  });

  it('falls back to the name without a signature', () => {
    expect(methodText('LIMITS', false, null, 'data', types)).toEqual({ label: 'LIMITS', data: [] });
    expect(methodText('save', true, undefined, 'signature', types)).toEqual({ label: 'save()', data: [] });
  });
});

describe('methodTooltip', () => {
  it('gives the declaration as written and the types in full', () => {
    expect(methodTooltip(update, types)).toBe('as written\nPlayerUpdate { jerseyNumber: number | null }\nPlayerDetail { id: string, name: string, jerseyNumber: number | null }');
    expect(methodTooltip(null, types)).toBe('');
  });
});
