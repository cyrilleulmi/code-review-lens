import { describe, expect, it } from 'vitest';
import { EdgeCoverage, TestCoverage, TestProfile } from './api';
import { bothSides, contractLines, httpCover, httpTitle, reachText, targetLabels } from './http-tests';

const direct: TestCoverage = { segmentId: 's3', direct: true, via: null, line: 7, mocked: false, http: true, endpoint: 'PUT /api/players/{}' };
const indirect: TestCoverage = { segmentId: 's5', direct: false, via: 's3', line: 7, mocked: false, http: true, endpoint: null };
const byCall: TestCoverage = { segmentId: 's9', direct: true, via: null, line: 3, mocked: false };

describe('HTTP-Tests', () => {
  it('finds reaches over HTTP and describes them', () => {
    expect(httpCover([direct, indirect, byCall], 's3')).toBe(direct);
    expect(httpCover([direct, indirect, byCall], 's9')).toBeNull();
    expect(httpCover([{ ...direct, mocked: true }], 's3')).toBeNull();
    expect(httpCover(undefined, 's3')).toBeNull();
    expect(httpTitle(direct)).toContain('PUT /api/players/{}');
    expect(httpTitle(indirect)).toContain('Endpunkt');
  });

  it('says how a test reaches the code', () => {
    expect(reachText({ ...direct })).toBe('direkt über HTTP: PUT /api/players/{} · Testzeile 7');
    expect(reachText({ ...indirect, via: 'update' })).toBe('über update (HTTP)');
    expect(reachText({ ...byCall })).toBe('direkt · Testzeile 3');
  });

  it('names the endpoint of a target reached over HTTP', () => {
    const profile = { targets: ['update', 'isInRange'] } as TestProfile;
    const names: Record<string, string> = { s3: 'update', s9: 'isInRange' };
    expect(targetLabels(profile, [direct, byCall], (id) => names[id])).toEqual(['update (PUT /api/players/{})', 'isInRange']);
    expect(targetLabels(profile, undefined, () => null)).toEqual(['update', 'isInRange']);
  });

  it('lists both sides of a REST edge', () => {
    const names: Record<string, string> = { s81: 'saves a new jersey number', s21: 'setsJerseyNumberSeven' };
    const name = (id: string) => names[id] ?? id;
    const both: EdgeCoverage = { from: 's44', to: 's3', status: 'separate', tests: [], clientTests: ['s81'], serverTests: ['s21'] };
    expect(bothSides(both)).toBe(true);
    const lines = contractLines(both, 'PUT /api/players/{}', name);
    expect(lines[0]).toBe('beidseitig geprüft: Frontend erwartet PUT /api/players/{}, Backend-Test ruft ihn auf');
    expect(lines).toContain('Frontend (erwartet die Anfrage): saves a new jersey number');
    expect(lines).toContain('Backend (ruft über HTTP auf): setsJerseyNumberSeven');

    const clientOnly = { ...both, serverTests: [] };
    expect(bothSides(clientOnly)).toBe(false);
    expect(contractLines(clientOnly, 'PUT /x', name)[0]).toContain('nur Frontend geprüft');
    expect(contractLines({ ...both, clientTests: [] }, 'PUT /x', name)[0]).toContain('nur Backend geprüft');
    expect(contractLines({ from: 'a', to: 'b', status: 'none', tests: [] }, 'PUT /x', name)).toEqual([]);
    expect(bothSides(undefined)).toBe(false);
  });
});
