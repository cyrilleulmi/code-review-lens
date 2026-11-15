import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { CodeCoverage, CoverageStatus, ExistingTest, Segment } from './api';
import { ExistingChip, basisText, basisWarnings, existingChip } from './existing-tests';
import { Icon, SymbolBadge } from './icon';
import { ReviewStore } from './review.store';

interface TestChip {
  id: string;
  name: string;
  direct: boolean;
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
}

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
 */
@Component({
  selector: 'app-coverage-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SymbolBadge],
  template: `
    <section class="box">
      <header>
        <app-icon name="test" [size]="15" class="head-icon" />
        <b>Abdeckung des geänderten Codes</b>
        <span class="hint">statisch ermittelt: Aufrufe aus Tests</span>
      </header>
      <div class="basis">
        <p>{{ basis() }}</p>
        @for (w of warnings(); track w) {
          <p class="warn"><app-icon name="warning" [size]="12" /> {{ w }}</p>
        }
      </div>
      @if (total() === 0) {
        <p class="summary">Keine geänderte Funktion, die Tests braucht – geändert sind nur Tests, Quick wins, Styles oder Konfiguration.</p>
      } @else {
        <p class="summary">
          <b>{{ count('direct') }}</b> von {{ total() }} geänderten {{ total() === 1 ? 'Funktion' : 'Funktionen' }} direkt getestet
          · <b>{{ count('indirect') }}</b> nur indirekt · <b>{{ count('existing') }}</b> nur durch bestehende Tests
          · <b [class.warn]="count('none') > 0">{{ count('none') }}</b> ohne Test
        </p>
        @for (g of groups(); track g.status) {
          @if (g.rows.length) {
            <button type="button" class="group-head" [class]="'group-head s-' + g.status" (click)="toggle(g.status)"
                    [attr.aria-expanded]="isOpen(g.status)">
              <app-icon [name]="isOpen(g.status) ? 'chevronDown' : 'chevronRight'" [size]="12" />
              {{ g.label }} <span class="n">{{ g.rows.length }}</span>
            </button>
            @if (isOpen(g.status)) {
              @for (r of g.rows; track r.segment.id) {
                <div class="row" [class.done]="r.done" role="button" tabindex="0" (click)="store.reveal(r.segment.id)"
                     (keydown.enter)="store.reveal(r.segment.id)" [title]="r.segment.path + ' – zum Code springen'">
                  <span class="name">
                    <app-symbol-badge [kind]="r.segment.symbolKind" />
                    <span class="sym">{{ r.segment.symbol }}</span>
                    @if (r.done) {
                      <app-icon name="check" [size]="12" class="ok" />
                    }
                  </span>
                  <span class="where">{{ fileOf(r.segment.path) }}:{{ range(r.segment) }}</span>
                  <span class="metric" title="Entscheidungen in der ganzen Funktion: if, case, catch, for, while, &amp;&amp;, ||, ?:">
                    {{ r.coverage.branches }} {{ r.coverage.branches === 1 ? 'Verzweigung' : 'Verzweigungen' }}</span>
                  <span class="metric" title="Geänderte Zeilen ohne Leerzeilen, Kommentare und reine Klammern">
                    {{ r.coverage.changedLines }} geändert</span>
                  <span class="tests">
                    @for (t of r.tests; track t.id) {
                      <button type="button" class="test" [class.indirect]="!t.direct" (click)="$event.stopPropagation(); testClick.emit(t.id)"
                              [title]="(t.direct ? 'Ruft die Funktion direkt auf' : 'Erreicht sie über anderen geänderten Code') + ' – zum Test springen'">
                        <app-symbol-badge kind="test" /> <span class="tname">{{ t.name }}</span>
                      </button>
                    }
                    @for (e of r.existing; track e.id) {
                      <span class="test existing" [title]="e.title" (click)="$event.stopPropagation()">
                        <app-symbol-badge kind="test" /> <span class="tname">{{ e.name }}</span> <span class="tline">{{ e.where }}</span>
                      </span>
                    }
                    @for (m of r.mocked; track m.id) {
                      <button type="button" class="test mocked" [disabled]="!m.changed"
                              (click)="$event.stopPropagation(); m.changed && testClick.emit(m.id)"
                              title="Erreicht nur einen Mock dieser Funktion – zählt nicht als Test">
                        <app-symbol-badge kind="test" /> <span class="tname">{{ m.name }}</span> <span class="mock-tag">Mock</span>
                      </button>
                    }
                    @if (!r.tests.length && !r.existing.length) {
                      <span class="none">kein Test erreicht sie</span>
                    }
                  </span>
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
    .basis { padding: 6px 12px; border-bottom: 1px solid var(--border); color: var(--fg-dim); font-size: 11.5px; }
    .basis p { display: flex; align-items: center; gap: 6px; margin: 0; }
    .basis p + p { margin-top: 3px; }
    .basis .warn { color: var(--warn); }
    .tname { overflow: hidden; text-overflow: ellipsis; }
    .none { color: var(--fg-dim); font-size: 11.5px; }
    .ok { color: var(--ok); }
    @media (max-width: 900px) {
      .row { grid-template-columns: minmax(0, 1fr) auto; }
      .tests { grid-column: 1 / -1; }
    }
  `,
})
export class CoverageOverview {
  protected readonly store = inject(ReviewStore);
  /** A test chip was clicked (test segment id). */
  readonly testClick = output<string>();

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
    return (this.analysis()?.coverage ?? [])
      .filter((c) => segs.has(c.segmentId))
      .map((c): CoverageRow => {
        const p = this.store.progressOf([{ segmentId: c.segmentId, place: null }]);
        return {
          segment: segs.get(c.segmentId)!,
          coverage: c,
          tests: [
            ...c.directTests.map((id) => ({ id, name: testName(id), direct: true })),
            ...c.indirectTests.map((id) => ({ id, name: testName(id), direct: false })),
          ],
          existing: (c.existingTests ?? []).filter((id) => existing.has(id)).map((id) => existingChip(existing.get(id)!, c.segmentId)),
          mocked: (c.mockedTests ?? []).map((id) => ({ id, name: this.store.testName()(id), changed: tests.has(id) })),
          done: p.total > 0 && p.ok === p.total,
        };
      });
  });

  protected readonly total = computed(() => this.rows().length);
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
