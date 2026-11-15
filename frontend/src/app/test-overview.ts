import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Segment } from './api';
import { Icon, SymbolBadge } from './icon';
import { ReviewStore } from './review.store';
import {
  ProfileColumn,
  ProfileFilter,
  ProfilePart,
  ProfileRow,
  ProfileSort,
  LEVEL_LABELS,
  SCENARIO_LABELS,
  assertionKinds,
  ASSERTION_LABELS,
  matchesFilter,
  nextSort,
  profileParts,
  profileSummary,
  sameFilter,
  sortRows,
} from './test-profile';

interface CoverRow {
  segment: Segment;
  direct: boolean;
  line: number | null;
  via: string | null;
  done: boolean;
}

interface TableRow extends ProfileRow {
  /** profile parts by key, for the tooltips of the cells */
  parts: Partial<Record<ProfilePart['key'], ProfilePart>>;
}

type ViewMode = 'list' | 'table';

const VIEW_KEY = 'scr.testOverview.view';

const COLUMNS: { id: ProfileColumn; label: string; num?: boolean; tip: string }[] = [
  { id: 'name', label: 'Test', tip: 'Suite › Testname' },
  { id: 'targets', label: 'Prüft', tip: 'Geänderter Code, den der Test direkt aufruft (sonst die Komponente aus dem Dateinamen)' },
  { id: 'scenario', label: 'Fall', tip: 'Fehlerfall, Grenzfall oder Normalfall – aus Testcode und Testname' },
  { id: 'level', label: 'Ebene', tip: 'Unit, Integration oder E2E – aus Annotationen, Aufrufen und Pfad' },
  { id: 'assertions', label: 'Assertions', num: true, tip: 'Anzahl Assertions im Testrumpf und ihre Art' },
  { id: 'mocks', label: 'Mocks', tip: 'Ersetzte Abhängigkeiten (Test, Setup, umschliessende Klasse/Suite)' },
  { id: 'cases', label: 'Fälle', num: true, tip: 'Parametrisierte Fälle (@ParameterizedTest, it.each, Go-Tabellentest)' },
];

/**
 * For each test case: its profile in one line (Test-Steckbrief: scenario, level, assertions, mocks, parameterised
 * cases), the components it is about and the changed code it reaches (statically: calls from the test code,
 * directly or through other changed functions). Every entry jumps to the code. «Tabelle» shows all tests as a
 * sortable table with a summary whose parts filter it.
 */
@Component({
  selector: 'app-test-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SymbolBadge],
  template: `
    <section class="box">
      <header>
        <app-icon name="test" [size]="15" class="head-icon" />
        <b>Testübersicht</b>
        <span class="hint">{{ rows().length }} {{ rows().length === 1 ? 'Testfall' : 'Testfälle' }} · statisch ermittelt aus dem Testcode</span>
        @if (tableRows().length) {
          <span class="toggle" role="group" aria-label="Darstellung">
            <button type="button" [class.on]="mode() === 'list'" [attr.aria-pressed]="mode() === 'list'" (click)="setMode('list')"
                    title="Pro Test: Steckbrief, Komponenten und erreichter Code">Liste</button>
            <button type="button" [class.on]="mode() === 'table'" [attr.aria-pressed]="mode() === 'table'" (click)="setMode('table')"
                    title="Alle Tests als sortierbare Tabelle mit Zusammenfassung">Tabelle</button>
          </span>
        }
      </header>
      @if (mode() === 'table' && tableRows().length) {
        <p class="summary">
          <span class="total">{{ summary().total }} {{ summary().total === 1 ? 'Test' : 'Tests' }}</span>
          @for (group of summary().groups; track $index) {
            <span class="sep">·</span>
            @for (part of group; track part.text) {
              @if (!$first) {
                <span class="comma">,</span>
              }
              <button type="button" class="sumpart" [class.on]="isFilter(part.filter)" [attr.aria-pressed]="isFilter(part.filter)"
                      (click)="toggleFilter(part.filter)" [title]="isFilter(part.filter) ? 'Filter aufheben' : 'Nur diese Tests zeigen'">{{ part.text }}</button>
            }
          }
          @if (filter()) {
            <button type="button" class="clear" (click)="filter.set(null)" title="Alle Tests zeigen">
              <app-icon name="close" [size]="11" /> Filter aufheben
            </button>
          }
        </p>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                @for (c of columns; track c.id) {
                  <th [class.num]="c.num" [attr.aria-sort]="sort()?.column === c.id ? (sort()!.desc ? 'descending' : 'ascending') : null">
                    <button type="button" (click)="sortBy(c.id)" [title]="c.tip + ' – klicken zum Sortieren'">
                      {{ c.label }}
                      <span class="arrow">{{ sort()?.column === c.id ? (sort()!.desc ? '▼' : '▲') : '' }}</span>
                    </button>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of shownRows(); track r.id) {
                @let p = r.profile;
                <tr tabindex="0" (click)="testClick.emit(r.id)" (keydown.enter)="testClick.emit(r.id)">
                  <td class="tname" [title]="r.name + ' – zum Test springen'">{{ r.name }}</td>
                  <td class="code" [title]="p.targets.join(', ')">{{ p.targets.join(', ') || '–' }}</td>
                  <td><span [class]="'scenario sc-' + p.scenario" [title]="r.parts.scenario?.tip ?? ''">{{ scenarioLabels[p.scenario] }}</span></td>
                  <td [title]="r.parts.level?.tip ?? ''">{{ levelLabels[p.level] }}</td>
                  <td class="num" [title]="r.parts.assertions?.tip ?? ''">
                    <span [class.zero]="!p.assertions">{{ p.assertions }}</span>
                    @if (kindsOf(r); as kinds) {
                      <span class="dim">{{ kinds }}</span>
                    }
                  </td>
                  <td class="code" [title]="r.parts.mocks?.tip ?? ''">{{ p.mocks.join(', ') || '–' }}</td>
                  <td class="num" [title]="r.parts.cases?.tip ?? ''">{{ casesOf(r) }}</td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="none">Kein Test passt auf den Filter.</td></tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        @for (t of rows(); track t.id) {
          <div class="test">
            <button type="button" class="name" (click)="testClick.emit(t.id)" title="Zum Testcode">
              <app-symbol-badge kind="test" /> {{ t.name }}
            </button>
            @if (t.parts.length) {
              <div class="profile">
                @for (part of t.parts; track part.key) {
                  @if (!$first) {
                    <span class="sep">·</span>
                  }
                  @if (part.key === 'scenario') {
                    <span [class]="'scenario sc-' + t.scenario" [title]="part.tip">{{ part.text }}</span>
                  } @else {
                    <span class="part" [class.zero]="part.key === 'assertions' && !t.assertions" [title]="part.tip">{{ part.text }}</span>
                  }
                }
              </div>
            }
            <span class="lbl">Komponenten</span>
            <div class="vals">
              @for (s of t.subjects; track s.name) {
                <button type="button" class="subject" [disabled]="!s.path" (click)="s.path && openFile(s.path)"
                        [title]="(s.how === 'name' ? 'Aus dem Namen der Testdatei' : 'Der Test ruft geänderten Code darin auf') + (s.path ? ' · ' + s.path : '')">
                  <app-icon [name]="s.path ? 'file' : 'info'" [size]="12" /> {{ s.name }}
                  @if (!s.inPr) {
                    <em>nicht im PR geändert</em>
                  }
                </button>
              } @empty {
                <span class="none">keine erkannt</span>
              }
            </div>
            <span class="lbl">Abgedeckt</span>
            <div class="vals">
              @for (c of t.covers; track c.segment.id) {
                <button type="button" class="cover" [class.indirect]="!c.direct" [class.done]="c.done" (click)="store.reveal(c.segment.id)"
                        [title]="c.segment.path + ' – zum Code springen'">
                  <app-symbol-badge [kind]="c.segment.symbolKind" />
                  <span class="sym">{{ c.segment.symbol ?? fileOf(c.segment.path) }}</span>
                  <span class="where">{{ fileOf(c.segment.path) }}:{{ range(c.segment) }}</span>
                  <span class="how">{{ c.direct ? 'direkt' + (c.line ? ' · Testzeile ' + c.line : '') : 'über ' + c.via }}</span>
                  @if (c.done) {
                    <app-icon name="check" [size]="12" class="ok" />
                  }
                </button>
              } @empty {
                <span class="none">Keine geänderte Codestelle erreicht – der Test ruft nur unveränderten Code auf.</span>
              }
            </div>
          </div>
        }
      }
    </section>
  `,
  styles: `
    .box { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel-2); margin-bottom: 16px; overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border); }
    .head-icon { color: var(--area-test); }
    header b { color: var(--fg); font-weight: 600; }
    .hint { color: var(--fg-dim); font-size: 11.5px; }
    .toggle { display: inline-flex; margin-left: auto; border: 1px solid var(--border-strong); border-radius: 5px; overflow: hidden; flex: none; }
    .toggle button { padding: 2px 10px; border: 0; background: none; color: var(--fg-muted); font: 11.5px var(--font-ui); cursor: pointer; }
    .toggle button + button { border-left: 1px solid var(--border-strong); }
    .toggle button:hover { color: var(--fg); }
    .toggle button.on { background: var(--bg-selected); color: var(--fg); }
    .test { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .test:last-child { border-bottom: 0; }
    .name { grid-column: 1 / -1; justify-self: start; display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; padding: 0;
      color: var(--fg); font: 600 12.5px var(--font-code); cursor: pointer; text-align: left; }
    .name:hover { color: var(--accent-fg); }
    .profile { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin-top: -2px;
      color: var(--fg-muted); font-size: 12px; }
    .profile .part { cursor: help; }
    .sep { color: var(--fg-dim); }
    .zero { color: var(--warn); }
    .scenario { padding: 0 6px; border: 1px solid var(--border-strong); border-radius: 4px; font-size: 11px; white-space: nowrap; cursor: help; }
    .sc-error { color: var(--del-fg); border-color: color-mix(in srgb, var(--del-fg) 45%, transparent);
      background: color-mix(in srgb, var(--del-fg) 12%, transparent); }
    .sc-edge { color: var(--accent-fg); border-color: color-mix(in srgb, var(--accent) 50%, transparent);
      background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .sc-normal { color: var(--fg-muted); }
    .lbl { color: var(--fg-dim); font-size: 11.5px; padding-top: 3px; }
    .vals { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    .subject, .cover { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 2px 8px; border: 1px solid var(--border-strong);
      border-radius: 5px; background: var(--bg-editor); color: var(--fg); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; }
    .subject:hover:not(:disabled), .cover:hover { border-color: var(--accent); }
    .subject:disabled { cursor: default; color: var(--fg-muted); }
    .subject em { font-style: normal; color: var(--fg-dim); font-size: 11px; }
    .cover.indirect { border-style: dashed; }
    .cover.done { border-color: var(--ok-border); }
    .sym { font-family: var(--font-code); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }
    .where { color: var(--fg-dim); font-size: 11px; }
    .how { color: var(--fg-muted); font-size: 11px; padding-left: 4px; border-left: 1px solid var(--border); }
    .ok { color: var(--ok); }
    .none { color: var(--fg-dim); font-size: 12px; padding-top: 2px; }
    .summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 4px; margin: 0; padding: 8px 12px; color: var(--fg-muted);
      font-size: 12.5px; border-bottom: 1px solid var(--border); }
    .summary .total { color: var(--fg); font-weight: 600; }
    .summary .sep { padding: 0 4px; }
    .summary .comma { margin-left: -4px; }
    .sumpart { padding: 0 4px; border: 1px solid transparent; border-radius: 4px; background: none; color: var(--fg-muted); font: inherit; cursor: pointer; }
    .sumpart:hover { color: var(--fg); border-color: var(--border-strong); }
    .sumpart.on { color: var(--fg); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .clear { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; border: 0; background: none; color: var(--fg-dim);
      font: 11.5px var(--font-ui); cursor: pointer; }
    .clear:hover { color: var(--accent-fg); }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { position: sticky; top: 0; padding: 0; background: var(--bg-panel); border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
    th button { width: 100%; padding: 5px 10px; border: 0; background: none; color: var(--fg-dim); font: 600 11.5px var(--font-ui); text-align: inherit; cursor: pointer; }
    th button:hover { color: var(--fg); }
    th.num { text-align: right; }
    .arrow { display: inline-block; width: 9px; font-size: 8px; color: var(--accent-fg); }
    td { padding: 4px 10px; border-bottom: 1px solid var(--border); color: var(--fg); vertical-align: baseline; max-width: 260px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.num { text-align: right; }
    td.code { font: 11.5px var(--font-code); color: var(--fg-muted); }
    td.tname { font: 12px var(--font-code); max-width: 340px; }
    td .dim { margin-left: 5px; color: var(--fg-dim); font-size: 11px; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: var(--bg-hover); }
    tbody tr:hover .tname { color: var(--accent-fg); }
    tbody tr:last-child td { border-bottom: 0; }
  `,
})
export class TestOverview {
  protected readonly store = inject(ReviewStore);
  readonly testIds = input.required<string[]>();
  readonly testClick = output<string>();

  protected readonly columns = COLUMNS;
  protected readonly scenarioLabels = SCENARIO_LABELS;
  protected readonly levelLabels = LEVEL_LABELS;
  /** List or table; remembered per viewer. */
  protected readonly mode = signal<ViewMode>(readMode());
  protected readonly filter = signal<ProfileFilter | null>(null);
  protected readonly sort = signal<ProfileSort | null>(null);

  protected readonly rows = computed(() => {
    const segs = this.store.segments();
    const tests = this.store.tests();
    return this.testIds()
      .map((id) => tests.get(id))
      .filter((t) => !!t)
      .map((t) => ({
        id: t.segmentId,
        name: t.name,
        subjects: t.subjects,
        scenario: t.profile?.scenario ?? 'normal',
        assertions: t.profile?.assertions ?? 0,
        parts: t.profile ? profileParts(t.profile) : [],
        covers: t.covers
          .filter((c) => segs.has(c.segmentId))
          .map((c): CoverRow => {
            const segment = segs.get(c.segmentId)!;
            const via = c.via ? segs.get(c.via) : null;
            const p = this.store.progressOf([{ segmentId: segment.id, place: null }]);
            return { segment, direct: c.direct, line: c.line, via: via ? shortName(via) : null, done: p.total > 0 && p.ok === p.total };
          }),
      }));
  });

  /** Tests with a profile (analyses of older versions have none). */
  protected readonly tableRows = computed((): TableRow[] => {
    const tests = this.store.tests();
    return this.testIds()
      .map((id) => tests.get(id))
      .filter((t) => !!t?.profile)
      .map((t) => ({
        id: t!.segmentId,
        name: t!.name,
        profile: t!.profile!,
        parts: Object.fromEntries(profileParts(t!.profile!).map((p) => [p.key, p])),
      }));
  });

  protected readonly summary = computed(() => profileSummary(this.tableRows().map((r) => r.profile)));

  protected readonly shownRows = computed(() => {
    const f = this.filter();
    return sortRows(this.tableRows().filter((r) => matchesFilter(r.profile, f)), this.sort()) as TableRow[];
  });

  protected setMode(mode: ViewMode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      // storage unavailable - the choice is just not remembered
    }
  }

  protected isFilter(f: ProfileFilter): boolean {
    return sameFilter(this.filter(), f);
  }

  protected toggleFilter(f: ProfileFilter): void {
    this.filter.set(this.isFilter(f) ? null : f);
  }

  protected sortBy(column: ProfileColumn): void {
    this.sort.set(nextSort(this.sort(), column));
  }

  /** «Gleichheit, HTTP» for the assertions cell, null when there are none. */
  protected kindsOf(r: TableRow): string | null {
    const kinds = assertionKinds(r.profile).map((k) => ASSERTION_LABELS[k.kind]);
    return kinds.length ? kinds.join(', ') : null;
  }

  protected casesOf(r: TableRow): string {
    const p = r.profile;
    return !p.parameterized ? '–' : p.cases == null ? '?' : String(p.cases);
  }

  protected openFile(path: string): void {
    this.store.select({ kind: 'file', path });
  }

  protected fileOf(path: string): string {
    return path.substring(path.lastIndexOf('/') + 1);
  }

  protected range(s: Segment): string {
    if (s.startLine && s.endLine) {
      return s.startLine === s.endLine ? `${s.startLine}` : `${s.startLine}–${s.endLine}`;
    }
    return s.lineKeys[0]?.substring(1) ?? '';
  }
}

function shortName(s: Segment): string {
  const name = s.symbol ?? s.path.substring(s.path.lastIndexOf('/') + 1);
  return name.substring(name.lastIndexOf('.') + 1);
}

/** The table is the default; the list only when the viewer chose it. */
function readMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'table';
  } catch {
    return 'table';
  }
}

