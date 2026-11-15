import { describe, expect, it } from 'vitest';
import { RuleCheck } from './api';
import { ruleChipText, ruleDetail, rulesSummary, sortChecks, unmetByLine, unmetCount, unmetWarning } from './rule-checks';

function check(over: Partial<RuleCheck>): RuleCheck {
  return { ruleId: 'r', label: 'Regel', segmentId: 's4', line: 10, code: null, trigger: null, met: false, metBy: [], tests: [], hint: '', ...over };
}

const transaction = check({ ruleId: 'transaction-integration', label: '@Transactional geändert → Integrationstest', line: 86, met: true, metBy: ['s45', 's46'], tests: ['s45', 's46'] });
const endpoint = check({
  ruleId: 'endpoint-http', label: 'Neuer Endpunkt → Test über HTTP', line: 87, trigger: 'DELETE /api/players/{}/jersey-number',
  tests: ['s45'], hint: 'Neuer Endpunkt ohne Test über HTTP',
});
const denied = check({
  ruleId: 'auth-denied', label: 'Zugriffsprüfung geändert → Test für verweigerten Zugriff', line: 92, trigger: 'access.requireCoach(',
  hint: 'Test für den verweigerten Zugriff (401/403) fehlt',
});
const other = check({ segmentId: 's3', line: 70, hint: 'x' });
const names = (id: string) => ({ s45: 'removesTheNumber', s46: 'isANoOpWithoutNumber' })[id] ?? id;

describe('rule checks (Erwartungs-Regeln)', () => {
  it('lists unmet checks first and keeps the order otherwise', () => {
    expect(sortChecks([transaction, endpoint, denied]).map((c) => c.ruleId)).toEqual(['endpoint-http', 'auth-denied', 'transaction-integration']);
    expect(unmetCount([transaction, endpoint, denied])).toBe(2);
  });

  it('summarises for the header and the overview', () => {
    expect(rulesSummary([transaction, endpoint, denied])).toBe('2 von 3 Regeln nicht erfüllt');
    expect(rulesSummary([transaction])).toBe('1 Regel erfüllt');
    expect(rulesSummary([transaction, transaction])).toBe('Alle 2 Regeln erfüllt');
    expect(rulesSummary([])).toBeNull();
    expect(unmetWarning([transaction, denied])).toBe('1 Erwartungs-Regel nicht erfüllt');
    expect(unmetWarning([endpoint, denied])).toBe('2 Erwartungs-Regeln nicht erfüllt');
    expect(unmetWarning([transaction])).toBeNull();
  });

  it('explains met and unmet checks', () => {
    expect(ruleChipText(denied)).toBe('Regel: Test für den verweigerten Zugriff (401/403) fehlt');
    expect(ruleChipText(check({ label: 'Nur Label' }))).toBe('Regel: Nur Label');
    expect(ruleDetail(transaction, names)).toBe('@Transactional geändert → Integrationstest – erfüllt durch removesTheNumber, isANoOpWithoutNumber');
    expect(ruleDetail(endpoint, names)).toBe(
      'Neuer Endpunkt → Test über HTTP (ausgelöst durch DELETE /api/players/{}/jersey-number) – Neuer Endpunkt ohne Test über HTTP;'
        + ' geprüft: removesTheNumber – keiner zeigt das',
    );
    expect(ruleDetail(denied, names)).toContain('kein Test erreicht den Code');
  });

  it('puts unmet checks of a segment on their trigger lines', () => {
    const byLine = unmetByLine([transaction, endpoint, denied, other], 's4');
    expect([...byLine.keys()]).toEqual([87, 92]);
    expect(byLine.get(92)).toEqual([denied]);
    expect(unmetByLine([other], 's4').size).toBe(0);
  });
});
