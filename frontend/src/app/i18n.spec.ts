import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FINDING_LABELS } from './commit-findings';
import { KIND_LABELS as MATRIX_KINDS } from './case-matrices';
import { KIND_LABELS as EXPECTATION_KINDS } from './expectations';
import { BOTH_SIDES_LABEL } from './http-tests';
import { EN } from './i18n.en';
import { SERVER_EN } from './i18n.server.en';
import { lang, serverText, setLang, t, translateServerText } from './i18n';
import { EDGE_LABELS, STEP_LABELS } from './mock-boundaries';
import { KIND_LABELS as SETUP_KINDS } from './setup-impact';
import { ASSERTION_LABELS, LEVEL_LABELS, SCENARIO_LABELS } from './test-profile';

const APP = join(process.cwd(), 'src/app');
const RULES = join(process.cwd(), '../backend/src/main/resources/rules/default-rules.json');

/** Every German key the sources pass to t(): direct literals, both sides of a ternary, and label tables. */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  const literal = String.raw`'((?:[^'\\]|\\.)*)'`;
  for (const file of readdirSync(APP).filter((f) => /\.(ts|html)$/.test(f) && !/\.spec\.ts$|^i18n/.test(f))) {
    const src = readFileSync(join(APP, file), 'utf-8');
    for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*` + literal, 'g'))) keys.add(m[1]);
    for (const m of src.matchAll(new RegExp(String.raw`\bt\([^'?;]*\?\s*` + literal + String.raw`\s*:\s*` + literal, 'g'))) {
      keys.add(m[1]);
      keys.add(m[2]);
    }
    // tables whose labels are translated where they are shown (AREAS, COLUMNS, GROUPS, MARKS, filters, …)
    for (const m of src.matchAll(new RegExp(String.raw`\b(?:label|tip): ` + literal, 'g'))) keys.add(m[1]);
  }
  for (const table of [FINDING_LABELS, MATRIX_KINDS, EXPECTATION_KINDS, STEP_LABELS, EDGE_LABELS, SETUP_KINDS,
    ASSERTION_LABELS, LEVEL_LABELS, SCENARIO_LABELS]) {
    Object.values(table).forEach((v) => keys.add(v));
  }
  keys.add(BOTH_SIDES_LABEL);
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  afterEach(() => setLang('de'));

  it('has an English text for every German UI text', () => {
    // language names and technical labels (TS, JS, …) are the same in both languages
    const missing = [...usedKeys()].filter((k) => !(k in EN) && !/^[A-Z#]{1,4}$|^(Java|Kotlin|Go|Python|Test|Setup|GitHub|GitLab)$/
.test(k));
    expect(missing).toEqual([]);
  });

  it('keeps the placeholders of every text', () => {
    const wrong = Object.entries(EN).filter(([de, en]) => placeholders(de).join() !== placeholders(en).join()).map(([de]) => de);
    expect(wrong).toEqual([]);
  });

  it('has no unused English texts', () => {
    const used = usedKeys();
    expect(Object.keys(EN).filter((k) => !used.has(k))).toEqual([]);
  });

  it('translates every text of the default rules', () => {
    const rules = JSON.parse(readFileSync(RULES, 'utf-8'));
    const texts: string[] = [];
    for (const c of rules.categories) texts.push(c.label, c.description, c.builds, c.divides);
    for (const section of ['rules', 'aspects', 'concerns']) {
      for (const r of rules[section]) texts.push(r.group, r.reason);
    }
    for (const r of rules.testRules) texts.push(r.label, r.hint);
    for (const s of Object.values(rules.testSmells) as { label: string; hint: string }[]) texts.push(s.label, s.hint);
    const missing = texts.filter((x) => typeof x === 'string' && x && !(x in SERVER_EN));
    expect(missing).toEqual([]);
  });

  it('switches the language at runtime', () => {
    expect(t('Übersicht')).toBe('Übersicht');
    setLang('en');
    expect(lang()).toBe('en');
    expect(t('Übersicht')).toBe('Overview');
    expect(t('{ok}/{total} Zeilen ok', { ok: 3, total: 7 })).toBe('3/7 lines ok');
    expect(t('nicht übersetzt')).toBe('nicht übersetzt');
    expect(document.documentElement.lang).toBe('en');
  });

  it('shows backend texts in German unless English is switched on', () => {
    expect(serverText('Datenflüsse')).toBe('Datenflüsse');
    setLang('en');
    expect(serverText('Datenflüsse')).toBe('Data flows');
    expect(serverText('Eigene Regel aus rules.json')).toBe('Eigene Regel aus rules.json');
    expect(serverText(null)).toBe('');
  });

  it('translates composed backend texts', () => {
    expect(translateServerText('4 Schritte')).toBe('4 steps');
    expect(translateServerText('Grenze 1…99')).toBe('Boundary 1…99');
    expect(translateServerText('wirft NotFoundException (404)')).toBe('throws NotFoundException (404)');
    expect(translateServerText('5 Verzweigungen, 1 Test')).toBe('5 branches, 1 test');
    expect(translateServerText('aufgerufen von PlayerResource.update')).toBe('called by PlayerResource.update');
    expect(translateServerText('Tabelle player')).toBe('Table player');
    expect(translateServerText('api.github.com 404 auf /repos/x/y: Not Found')).toBe('api.github.com 404 on /repos/x/y: Not Found');
    expect(translateServerText('Ungültige Antwort von GitLab: HTML statt JSON. Login-Seite eines SSO-Proxys? Ist das Cookie abgelaufen?'))
      .toBe('Invalid response from GitLab: HTML instead of JSON. Login page of an SSO proxy? Has the cookie expired?');
    expect(translateServerText('Ungültige URL: «gitlab.example.com». Erwartet wird z. B. https://gitlab.example.com'))
      .toBe('Invalid URL: “gitlab.example.com”. Expected e.g. https://gitlab.example.com');
    expect(translateServerText('GitHub lässt sich hier nicht konfigurieren')).toBe('GitHub cannot be configured here');
    expect(translateServerText('Nach Regel-Gruppe: Migrationen, Repositories & Queries. Zusätzliche Segmente nach Datei.'))
      .toBe('By rule group: Migrations, Repositories & queries. Additional segments by file.');
    expect(translateServerText('Segmente, auf die eine Regel dieser Kategorie passt. Übersetzungen: Übersetzungsdatei · '
      + 'Mapper: Mapper-Datei (Name); Reine Feldzuweisungen in einer Mapping-Funktion. Zusätzlich jeder Code der '
      + 'Architektur-Schicht «Adapter». Die Schicht wird aus den Ordnern des Repositories erkannt und nur vergeben, wenn es '
      + 'Ports & Adapters oder ein Schichten-Layout mit Adaptern nutzt.'))
      .toBe('Segments matched by a rule of this category. Translations: Translation file · Mappers: Mapper file (name); '
        + 'Plain field assignments in a mapping function. In addition, all code of the architecture layer “Adapters”. The '
        + 'layer is recognised from the folders of the repository and only assigned when it uses ports & adapters or a '
        + 'layered layout with adapters.');
    expect(translateServerText('PlayerService.update geändert in 1a2b3c4, ohne Test im Commit. Kein Test erreicht diesen Code.'))
      .toBe('PlayerService.update changed in 1a2b3c4, without a test in the commit. No test reaches this code.');
    expect(translateServerText('Test geschrieben in 1111111 «add test», Erwartung nachträglich in 2222222 «fix tests» geändert: '
      + '«expect(x).toBe(2)». Verdächtig: der Commit ändert nur Tests, sein Titel passt Tests an – wurde der Test an den Code angepasst?'))
      .toBe('Test written in 1111111 “add test”, expectation changed later in 2222222 “fix tests”: «expect(x).toBe(2)». '
        + 'Suspicious: the commit only changes tests, its title adjusts tests – was the test adapted to the code?');
  });

  it('leaves a composed text with an unknown part German', () => {
    const text = 'Nach Datei. Etwas ganz anderes.';

    expect(translateServerText(text)).toBe(text);
  });
});
