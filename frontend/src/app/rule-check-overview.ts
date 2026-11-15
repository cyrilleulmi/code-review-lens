import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { RuleCheck, Segment } from './api';
import { Icon, SymbolBadge } from './icon';
import { ReviewStore } from './review.store';
import { ruleDetail, rulesSummary, sortChecks } from './rule-checks';
import { SpecLineTarget } from './spec-overview';

interface RuleRow {
  check: RuleCheck;
  segment: Segment;
  /** the tests that meet it: changed ones can be opened, existing ones only show their name */
  tests: { id: string; name: string; changed: boolean }[];
  detail: string;
}

/**
 * Erwartungs-Regeln: the rules «if X changes, expect a test of form Y» that apply to the change (rules section
 * «testRules»). Unmet checks first with the hint; met ones collapsed with the tests that satisfy them. A row jumps to the
 * trigger line, a test chip to the test.
 */
@Component({
  selector: 'app-rule-check-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SymbolBadge],
  template: `
    <section class="box">
      <header>
        <app-icon name="shield" [size]="15" class="head-icon" />
        <b>Erwartete Tests (Regeln)</b>
        <span class="hint">musterbasiert: wenn X geändert wird, braucht es einen Test der Form Y</span>
        @if (summary(); as s) {
          <span class="sum" [class.warn]="unmet().length > 0">
            <app-icon [name]="unmet().length ? 'warning' : 'check'" [size]="12" /> {{ s }}</span>
        }
      </header>
      @if (rows().length === 0) {
        <p class="empty">Keine Erwartungs-Regel greift für die Änderungen.</p>
      }
      @for (r of unmet(); track r.check.ruleId + r.check.segmentId) {
        <div class="row open" role="button" tabindex="0" (click)="openLine(r)" (keydown.enter)="openLine(r)"
             [title]="r.detail + ' – zur auslösenden Zeile springen'">
          <app-icon name="warning" [size]="12" class="mark" />
          <span class="label">{{ r.check.label }}</span>
          <span class="name"><app-symbol-badge [kind]="r.segment.symbolKind" /> <span class="sym">{{ r.segment.symbol ?? fileOf(r.segment.path) }}</span></span>
          <span class="where">{{ fileOf(r.segment.path) }}{{ r.check.line != null ? ':' + r.check.line : '' }}</span>
          <span class="text">{{ r.check.hint }}
            @if (r.check.tests.length) {
              <span class="muted">· {{ r.check.tests.length }} {{ r.check.tests.length === 1 ? 'Test erreicht' : 'Tests erreichen' }} den Code, keiner zeigt das</span>
            } @else {
              <span class="muted">· kein Test erreicht den Code</span>
            }
          </span>
        </div>
      }
      @if (met().length) {
        <button type="button" class="group-head" (click)="showMet.set(!showMet())" [attr.aria-expanded]="showMet()">
          <app-icon [name]="showMet() ? 'chevronDown' : 'chevronRight'" [size]="12" />
          <app-icon name="check" [size]="12" class="ok" /> Erfüllt <span class="n">{{ met().length }}</span>
        </button>
        @if (showMet()) {
          @for (r of met(); track r.check.ruleId + r.check.segmentId) {
            <div class="row" role="button" tabindex="0" (click)="openLine(r)" (keydown.enter)="openLine(r)"
                 [title]="r.detail + ' – zur auslösenden Zeile springen'">
              <app-icon name="check" [size]="12" class="mark ok" />
              <span class="label">{{ r.check.label }}</span>
              <span class="name"><app-symbol-badge [kind]="r.segment.symbolKind" /> <span class="sym">{{ r.segment.symbol ?? fileOf(r.segment.path) }}</span></span>
              <span class="where">{{ fileOf(r.segment.path) }}{{ r.check.line != null ? ':' + r.check.line : '' }}</span>
              <span class="tests">
                @for (t of r.tests; track t.id) {
                  <button type="button" class="test" [disabled]="!t.changed" (click)="$event.stopPropagation(); t.changed && testClick.emit(t.id)"
                          [title]="t.changed ? 'Zum Test springen' : 'Bestehender Test, nicht im PR'">
                    <app-symbol-badge kind="test" /> <span class="tname">{{ t.name }}</span>
                  </button>
                }
              </span>
            </div>
          }
        }
      }
    </section>
  `,
  styles: `
    .box { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel-2); margin-bottom: 16px; overflow: hidden; }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border); }
    .head-icon { color: var(--area-test); }
    header b { color: var(--fg); font-weight: 600; }
    .hint { color: var(--fg-dim); font-size: 11.5px; }
    .sum { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--ok); font-size: 11.5px; font-weight: 600; }
    .sum.warn { color: var(--warn); }
    .empty { margin: 0; padding: 8px 12px; color: var(--fg-muted); font-size: 12.5px; }
    .row { display: grid; grid-template-columns: 14px minmax(180px, 1.3fr) minmax(140px, 1fr) auto minmax(0, 2fr); align-items: center; gap: 4px 10px;
      padding: 6px 12px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12px; }
    .row:hover { background: var(--bg-hover); }
    .row:last-child { border-bottom: 0; }
    .mark { color: var(--warn); }
    .mark.ok, .ok { color: var(--ok); }
    .label { color: var(--fg); font-weight: 600; }
    .row.open .label { color: var(--warn); }
    .name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .sym { font: 600 12px var(--font-code); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row:hover .sym { color: var(--accent-fg); }
    .where { color: var(--fg-dim); font-size: 11px; white-space: nowrap; }
    .text { color: var(--fg); min-width: 0; }
    .muted { color: var(--fg-dim); font-size: 11.5px; }
    .group-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 12px; border: 0; border-bottom: 1px solid var(--border);
      background: var(--bg-panel); color: var(--fg-muted); font: 600 12px var(--font-ui); cursor: pointer; text-align: left; }
    .group-head:hover { color: var(--fg); }
    .group-head .n { padding: 0 6px; border-radius: 8px; background: var(--bg-hover); color: var(--fg-muted); font-size: 11px; font-weight: 500; }
    .tests { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
    .test { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 1px 7px; border: 1px solid var(--border-strong); border-radius: 5px;
      background: var(--bg-editor); color: var(--fg); font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap; overflow: hidden; }
    .test:hover { border-color: var(--accent); }
    .test:disabled { border-style: dashed; border-color: var(--border); background: transparent; color: var(--fg-muted); cursor: default; }
    .tname { overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 900px) {
      .row { grid-template-columns: 14px minmax(0, 1fr) auto; }
      .text, .tests { grid-column: 2 / -1; }
    }
  `,
})
export class RuleCheckOverview {
  protected readonly store = inject(ReviewStore);
  /** A test chip was clicked (test segment id). */
  readonly testClick = output<string>();
  /** A check was clicked: its trigger line. */
  readonly lineClick = output<SpecLineTarget>();
  protected readonly showMet = signal(false);

  private readonly rows = computed(() => {
    const segs = this.store.segments();
    const tests = this.store.tests();
    const testName = this.store.testName();
    return sortChecks(this.store.ruleChecks())
      .filter((c) => segs.has(c.segmentId))
      .map((c): RuleRow => ({
        check: c,
        segment: segs.get(c.segmentId)!,
        tests: c.metBy.map((id) => ({ id, name: testName(id), changed: tests.has(id) })),
        detail: ruleDetail(c, testName),
      }));
  });

  protected readonly unmet = computed(() => this.rows().filter((r) => !r.check.met));
  protected readonly met = computed(() => this.rows().filter((r) => r.check.met));
  protected readonly summary = computed(() => rulesSummary(this.rows().map((r) => r.check)));

  /** Jump to the trigger line (or the block when the check has none). */
  protected openLine(r: RuleRow): void {
    if (r.check.line != null) {
      this.lineClick.emit({ segmentId: r.check.segmentId, line: r.check.line, old: false });
    } else {
      this.store.reveal(r.check.segmentId);
    }
  }

  protected fileOf(path: string): string {
    return path.substring(path.lastIndexOf('/') + 1);
  }
}
