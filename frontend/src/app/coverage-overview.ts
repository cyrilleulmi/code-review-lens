import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { CaseFinding, CodeCoverage, CoverageStatus, ExistingTest, Segment } from './api';
import { compactLine, findingDetail, findingsSummary, openFindings } from './case-checks';
import { ExistingChip, basisText, basisWarnings, existingChip } from './existing-tests';
import { HTTP_TAG, httpCover, httpTitle } from './http-tests';
import { Icon, SymbolBadge } from './icon';
import { t } from './i18n';
import { ReviewStore } from './review.store';
import { SpecLineTarget } from './spec-overview';

interface TestChip {
  id: string;
  name: string;
  direct: boolean;
  /** HTTP-Tests: the reach starts with a real request of the test; tooltip part, null otherwise */
  http: string | null;
}

interface CoverageRow {
  segment: Segment;
  coverage: CodeCoverage;
  tests: TestChip[];
  /** existing, unchanged tests reaching it (not in the diff: no navigation) */
  existing: ExistingChip[];
  /** tests that reach only a mock of it (Mock-Grenzen): not counted; changed ones can be opened */
  mocked: { id: string; name: string; changed: boolean }[];
  done: boolean;
  /** Fall- und Effekt-Abgleich: all findings, how many are open, and the compact line (open first, branch hint last) */
  findings: CaseFinding[];
  open: number;
  compact: string[];
}

/** Labels in German, translated with t(). */
const GROUPS: { status: CoverageStatus; label: string }[] = [
  { status: 'none', label: 'Ohne Test' },
  { status: 'indirect', label: 'Nur indirekt getestet' },
  { status: 'existing', label: 'Nur durch bestehende Tests' },
  { status: 'direct', label: 'Direkt getestet' },
];

/**
 * Coverage seen from the code: every testable changed function and whether a changed test reaches it - directly,
 * only via other changed code, only an existing (unchanged) test, or not at all (static, see CodeCoverage). A row
 * jumps to the code, a test chip to the test; chips of existing tests show file:line only (not part of the diff).
 * Below each row the Fall- und Effekt-Abgleich in one line (open findings, the branch hint), expandable to all findings;
 * a finding jumps to its line.
 */
@Component({
  selector: 'app-coverage-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SymbolBadge],
  template: `
    <section class="box">
      <header>
        <app-icon name="test" [size]="15" class="head-icon" />
        <b>{{ t('Abdeckung des geänderten Codes') }}</b>
        <span class="hint">{{ t('statisch ermittelt: Aufrufe aus Tests') }}</span>
        @if (casesSummary(); as cs) {
          <span class="cases-sum" [title]="t('Fehlerfälle, Grenzen und Wirkungen im Code, die kein Test prüft, der die Funktion wirklich erreicht')">
            <app-icon name="warning" [size]="12" /> {{ cs }}</span>
        }
      </header>
      <div class="basis">
        <p>{{ basis() }}</p>
        @for (w of warnings(); track w) {
          <p class="warn"><app-icon name="warning" [size]="12" /> {{ w }}</p>
        }
      </div>
      @if (total() === 0) {
        <p class="summary">{{ t('Keine geänderte Funktion, die Tests braucht – geändert sind nur Tests, Quick wins, Styles oder Konfiguration.') }}</p>
      } @else {
        <p class="summary">
          {{ t(total() === 1 ? '{n} von {total} geänderten Funktion direkt getestet' : '{n} von {total} geänderten Funktionen direkt getestet', { n: count('direct'), total: total() }) }}
          · {{ t('{n} nur indirekt', { n: count('indirect') }) }} · {{ t('{n} nur durch bestehende Tests', { n: count('existing') }) }}
          · <b [class.warn]="count('none') > 0">{{ t('{n} ohne Test', { n: count('none') }) }}</b>
        </p>
        @for (g of groups(); track g.status) {
          @if (g.rows.length) {
            <button type="button" class="group-head" [class]="'group-head s-' + g.status" (click)="toggle(g.status)"
                    [attr.aria-expanded]="isOpen(g.status)">
              <app-icon [name]="isOpen(g.status) ? 'chevronDown' : 'chevronRight'" [size]="12" />
              {{ t(g.label) }} <span class="n">{{ g.rows.length }}</span>
              @if (openRows(g.rows); as n) {
                <span class="open-n" [title]="t(n === 1 ? '{n} Funktion mit offenen Fällen' : '{n} Funktionen mit offenen Fällen', { n })"><app-icon name="warning" [size]="11" /> {{ n }}</span>
              }
            </button>
            @if (isOpen(g.status)) {
              @for (r of g.rows; track r.segment.id) {
                <div class="row" [class.done]="r.done" role="button" tabindex="0" (click)="store.reveal(r.segment.id)"
                     (keydown.enter)="store.reveal(r.segment.id)" [title]="r.segment.path + ' – ' + t('zum Code springen')">
                  <span class="name">
                    <app-symbol-badge [kind]="r.segment.symbolKind" />
                    <span class="sym">{{ r.segment.symbol }}</span>
                    @if (r.done) {
                      <app-icon name="check" [size]="12" class="ok" />
                    }
                    @if (r.open) {
                      <app-icon name="warning" [size]="12" class="open-mark" [title]="t(r.open === 1 ? '{n} offener Fall' : '{n} offene Fälle', { n: r.open }) + ': ' + t('kein Test prüft das')" />
                    }
                  </span>
                  <span class="where">{{ fileOf(r.segment.path) }}:{{ range(r.segment) }}</span>
                  <span class="metric" [title]="t('Entscheidungen in der ganzen Funktion: if, case, catch, for, while, &&, ||, ?:')">
                    {{ t(r.coverage.branches === 1 ? '{n} Verzweigung' : '{n} Verzweigungen', { n: r.coverage.branches }) }}</span>
                  <span class="metric" [title]="t('Geänderte Zeilen ohne Leerzeilen, Kommentare und reine Klammern')">
                    {{ t('{n} geändert', { n: r.coverage.changedLines }) }}</span>
                  <span class="tests">
                    @for (tt of r.tests; track tt.id) {
                      <button type="button" class="test" [class.indirect]="!tt.direct" (click)="$event.stopPropagation(); testClick.emit(tt.id)"
                              [title]="t(tt.direct ? 'Ruft die Funktion direkt auf' : 'Erreicht sie über anderen geänderten Code') + (tt.http ? ' · ' + tt.http : '') + ' – ' + t('zum Test springen')">
                        <app-symbol-badge kind="test" /> <span class="tname">{{ tt.name }}</span>
                        @if (tt.http) {
                          <span class="http-tag">{{ httpTag }}</span>
                        }
                      </button>
                    }
                    @for (e of r.existing; track e.id) {
                      <span class="test existing" [title]="e.title" (click)="$event.stopPropagation()">
                        <app-symbol-badge kind="test" /> <span class="tname">{{ e.name }}</span> <span class="tline">{{ e.where }}</span>
                        @if (e.http) {
                          <span class="http-tag">{{ httpTag }}</span>
                        }
                      </span>
                    }
                    @for (m of r.mocked; track m.id) {
                      <button type="button" class="test mocked" [disabled]="!m.changed"
                              (click)="$event.stopPropagation(); m.changed && testClick.emit(m.id)"
                              [title]="t('Erreicht nur einen Mock dieser Funktion – zählt nicht als Test')">
                        <app-symbol-badge kind="test" /> <span class="tname">{{ m.name }}</span> <span class="mock-tag">Mock</span>
                      </button>
                    }
                    @if (!r.tests.length && !r.existing.length) {
                      <span class="none">{{ t('kein Test erreicht sie') }}</span>
                    }
                  </span>
                  @if (r.findings.length) {
                    <button type="button" class="cases" [class.has-open]="r.open > 0" (click)="toggleCases(r.segment.id, $event)"
                            [attr.aria-expanded]="casesOpen(r.segment.id)" [title]="t('Fälle und Wirkungen im Code gegen das, was die Tests prüfen – Klick: alle zeigen')">
                      <app-icon [name]="casesOpen(r.segment.id) ? 'chevronDown' : 'chevronRight'" [size]="11" />
                      @if (r.open) {
                        <app-icon name="warning" [size]="11" />
                      }
                      @for (c of r.compact; track $index) {
                        @if ($index) {
                          <span class="dot">·</span>
                        }
                        <span>{{ c }}</span>
                      }
                      @if (!r.compact.length) {
                        <span class="all-ok">{{ t(r.findings.length === 1 ? '{n} Fall geprüft' : '{n} Fälle geprüft', { n: r.findings.length }) }}</span>
                      }
                    </button>
                    @if (casesOpen(r.segment.id)) {
                      <ul class="case-list">
                        @for (f of r.findings; track $index) {
                          <li [class.checked]="f.checked" [class.info]="f.kind === 'branches'" [class.clickable]="f.line != null"
                              (click)="openFinding(r.segment.id, f, $event)" [title]="f.code ?? ''">
                            <app-icon [name]="f.checked ? 'check' : f.kind === 'branches' ? 'info' : 'warning'" [size]="11" />
                            <span class="ctext">{{ detail(f) }}</span>
                            @if (f.line != null) {
                              <span class="cline">:{{ f.line }}</span>
                            }
                          </li>
                        }
                      </ul>
                    }
                  }
                </div>
              }
            }
          }
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
    .summary { margin: 0; padding: 8px 12px; color: var(--fg-muted); font-size: 12.5px; border-bottom: 1px solid var(--border); }
    .summary b { color: var(--fg); font-weight: 600; }
    .summary b.warn { color: var(--warn); }
    .group-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 12px; border: 0; border-bottom: 1px solid var(--border);
      background: var(--bg-panel); color: var(--fg-muted); font: 600 12px var(--font-ui); cursor: pointer; text-align: left; }
    .group-head:hover { color: var(--fg); }
    .group-head.s-none { color: var(--warn); }
    .group-head .n { padding: 0 6px; border-radius: 8px; background: var(--bg-hover); color: var(--fg-muted); font-size: 11px; font-weight: 500; }
    .row { display: grid; grid-template-columns: minmax(160px, 1.2fr) minmax(110px, 0.8fr) auto auto minmax(0, 2fr); align-items: center; gap: 6px 12px;
      padding: 6px 12px 6px 30px; border-bottom: 1px solid var(--border); cursor: pointer; }
    .row:hover { background: var(--bg-hover); }
    .row:last-child { border-bottom: 0; }
    .name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .sym { font: 600 12px var(--font-code); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row:hover .sym { color: var(--accent-fg); }
    .where { color: var(--fg-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric { color: var(--fg-muted); font-size: 11px; white-space: nowrap; }
    .tests { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
    .test { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 1px 7px; border: 1px solid var(--border-strong); border-radius: 5px;
      background: var(--bg-editor); color: var(--fg); font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap; overflow: hidden; }
    .test:hover { border-color: var(--accent); }
    .test.indirect { border-style: dashed; }
    .test.existing { border-style: dashed; border-color: var(--border); background: transparent; color: var(--fg-muted); cursor: default; }
    .test.existing:hover { border-color: var(--border-strong); }
    .tline { color: var(--fg-dim); font-size: 11px; }
    .test.mocked { border-style: dashed; border-color: color-mix(in srgb, var(--run-mocked) 55%, transparent); color: var(--fg-muted); }
    .test.mocked:disabled { cursor: default; }
    .mock-tag { color: var(--run-mocked); font-size: 10px; font-weight: 600; }
    .http-tag { color: var(--accent-fg); font-size: 10px; font-weight: 600; }
    .basis { padding: 6px 12px; border-bottom: 1px solid var(--border); color: var(--fg-dim); font-size: 11.5px; }
    .basis p { display: flex; align-items: center; gap: 6px; margin: 0; }
    .basis p + p { margin-top: 3px; }
    .basis .warn { color: var(--warn); }
    .tname { overflow: hidden; text-overflow: ellipsis; }
    .none { color: var(--fg-dim); font-size: 11.5px; }
    .cases-sum { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--warn); font-size: 11.5px; font-weight: 600; }
    .open-n { display: inline-flex; align-items: center; gap: 3px; color: var(--warn); font-size: 11px; font-weight: 600; }
    .open-mark { color: var(--warn); }
    .cases { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; justify-self: start; max-width: 100%;
      padding: 0; border: 0; background: none; color: var(--fg-muted); font: 11.5px var(--font-ui); cursor: pointer; text-align: left; }
    .cases.has-open { color: var(--warn); }
    .cases:hover { color: var(--accent-fg); }
    .cases .dot { color: var(--fg-dim); }
    .cases .all-ok { color: var(--ok); }
    .case-list { grid-column: 1 / -1; margin: 0; padding: 0 0 2px 16px; list-style: none; font-size: 11.5px; cursor: default; }
    .case-list li { display: flex; align-items: center; gap: 6px; padding: 1px 0; color: var(--warn); }
    .case-list li.checked { color: var(--ok); }
    .case-list li.info { color: var(--fg-muted); }
    .case-list li.clickable { cursor: pointer; }
    .case-list li.clickable:hover .ctext { color: var(--accent-fg); text-decoration: underline; }
    .case-list .ctext { color: var(--fg); }
    .case-list .cline { color: var(--fg-dim); font-size: 11px; }
    .ok { color: var(--ok); }
    @media (max-width: 900px) {
      .row { grid-template-columns: minmax(0, 1fr) auto; }
      .tests { grid-column: 1 / -1; }
    }
  `,
})
export class CoverageOverview {
  protected readonly store = inject(ReviewStore);
  protected readonly t = t;
  protected readonly httpTag = HTTP_TAG;
  /** A test chip was clicked (test segment id). */
  readonly testClick = output<string>();
  /** A finding was clicked: its line in the changed function. */
  readonly lineClick = output<SpecLineTarget>();
  /** Rows whose findings are expanded. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  /** Groups shown expanded; the directly tested ones start collapsed. */
  private readonly open = signal<ReadonlySet<CoverageStatus>>(new Set<CoverageStatus>(['none', 'indirect', 'existing']));

  private readonly analysis = computed(() => this.store.bundle()?.analysis);
  protected readonly basis = computed(() => basisText(this.analysis()?.relatedTests));
  protected readonly warnings = computed(() => basisWarnings(this.analysis()?.relatedTests));

  private readonly rows = computed(() => {
    const segs = this.store.segments();
    const tests = this.store.tests();
    const testName = (id: string) => tests.get(id)?.name ?? segs.get(id)?.symbol ?? id;
    const existing = new Map<string, ExistingTest>((this.analysis()?.existingTests ?? []).map((t) => [t.id, t]));
    const viaHttp = (test: string, segmentId: string) => {
      const c = httpCover(tests.get(test)?.covers, segmentId);
      return c ? httpTitle(c) : null;
    };
    return (this.analysis()?.coverage ?? [])
      .filter((c) => segs.has(c.segmentId))
      .map((c): CoverageRow => {
        const p = this.store.progressOf([{ segmentId: c.segmentId, place: null }]);
        return {
          segment: segs.get(c.segmentId)!,
          coverage: c,
          tests: [
            ...c.directTests.map((id) => ({ id, name: testName(id), direct: true, http: viaHttp(id, c.segmentId) })),
            ...c.indirectTests.map((id) => ({ id, name: testName(id), direct: false, http: viaHttp(id, c.segmentId) })),
          ],
          existing: (c.existingTests ?? []).filter((id) => existing.has(id)).map((id) => existingChip(existing.get(id)!, c.segmentId)),
          mocked: (c.mockedTests ?? []).map((id) => ({ id, name: this.store.testName()(id), changed: tests.has(id) })),
          done: p.total > 0 && p.ok === p.total,
          findings: c.findings ?? [],
          open: openFindings(c).length,
          compact: compactLine(c),
        };
      });
  });

  protected readonly total = computed(() => this.rows().length);
  protected readonly casesSummary = computed(() => findingsSummary(this.rows().map((r) => r.coverage)));
  protected readonly groups = computed(() =>
    GROUPS.map((g) => ({ ...g, rows: this.rows().filter((r) => r.coverage.status === g.status) })),
  );

  protected count(status: CoverageStatus): number {
    return this.groups().find((g) => g.status === status)?.rows.length ?? 0;
  }

  protected isOpen(status: CoverageStatus): boolean {
    return this.open().has(status);
  }

  protected toggle(status: CoverageStatus): void {
    const next = new Set(this.open());
    next.has(status) ? next.delete(status) : next.add(status);
    this.open.set(next);
  }

  /** Rows with open findings in a group (marker on the group head, also for «direkt getestet»). */
  protected openRows(rows: CoverageRow[]): number {
    return rows.filter((r) => r.open > 0).length;
  }

  protected casesOpen(id: string): boolean {
    return this.expanded().has(id);
  }

  protected toggleCases(id: string, event: Event): void {
    event.stopPropagation();
    const next = new Set(this.expanded());
    next.has(id) ? next.delete(id) : next.add(id);
    this.expanded.set(next);
  }

  protected detail(f: CaseFinding): string {
    return findingDetail(f, this.store.testName());
  }

  /** A finding with a line: jump to that line of the function. */
  protected openFinding(segmentId: string, f: CaseFinding, event: Event): void {
    event.stopPropagation();
    if (f.line != null) {
      this.lineClick.emit({ segmentId, line: f.line, old: false });
    }
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
