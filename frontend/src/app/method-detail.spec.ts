import { describe, expect, it } from 'vitest';
import { Signature, TypeInfo } from './api';
import { methodLabel, methodTooltip, returnType, signatureLabel, typeLine } from './method-detail';

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

describe('methodLabel', () => {
  it('shows the name or the signature', () => {
    expect(methodLabel('update', true, update, 'name')).toBe('update()');
    expect(methodLabel('update', true, update, 'signature')).toBe('update(id: string, change: PlayerUpdate): Observable<PlayerDetail>');
  });

  it('cuts the signature to the room a diagram has', () => {
    expect(methodLabel('update', true, update, 'signature', 40)).toBe('update(…): Observable<PlayerDetail>');
  });

  it('falls back to the name without a signature', () => {
    expect(methodLabel('LIMITS', false, null, 'signature')).toBe('LIMITS');
    expect(methodLabel('save', true, undefined, 'signature')).toBe('save()');
  });
});

describe('returnType', () => {
  it('gives the declared return type', () => {
    expect(returnType(update)).toBe('Observable<PlayerDetail>');
    expect(returnType(signature([], 'int'))).toBe('int');
  });

  it('gives nothing for no, an unknown or a void-like return type', () => {
    expect(returnType(null)).toBeNull();
    expect(returnType(signature([], null))).toBeNull();
    for (const nothing of ['void', 'Unit', 'None', 'Promise<void>', 'Mono<Void>', 'CompletableFuture<Void>', 'Observable<void>']) {
      expect(returnType(signature([], nothing))).toBeNull();
    }
  });

  it('cuts a long type', () => {
    expect(returnType(signature([], 'Map<String, List<VeryLongTypeName>>'), 20)).toBe('Map<String, List<Ve…');
  });
});

describe('methodTooltip', () => {
  it('gives the declaration as written and the types in full', () => {
    expect(methodTooltip(update, types)).toBe('as written\nPlayerUpdate { jerseyNumber: number | null }\nPlayerDetail { id: string, name: string, jerseyNumber: number | null }');
    expect(methodTooltip(null, types)).toBe('');
  });
});
