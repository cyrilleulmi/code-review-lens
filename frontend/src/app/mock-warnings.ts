import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { MockWarning } from './api';
import { Icon, SymbolBadge } from './icon';
import { lineOwner } from './mock-boundaries';
import { ReviewStore } from './review.store';
import { SpecLineTarget } from './spec-overview';

interface WarningRow {
  warning: MockWarning;
  /** a changed test (in the diff): click jumps to the line; existing tests only show file:line */
  changed: boolean;
  where: string;
}

/**
 * Mock-Grenzen: tests that replace changed code by a mock and stub that very function - they check the old behaviour,
 * not the new one. One row per test and mocked member; a click jumps to the line of the stub in the test.
 */
@Component({
  selector: 'app-mock-warnings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SymbolBadge],
  template: `
    @if (rows().length) {
      <section class="box">
        <header>
          <app-icon name="warning" [size]="15" class="head-icon" />
          <b>Mocks auf geändertem Code</b>
          <span class="hint">{{ rows().length }} · diese Tests ersetzen eine geänderte Funktion durch einen Mock und prüfen so ihr altes Verhalten</span>
        </header>
        @for (r of rows(); track r.warning.test + r.warning.segmentId) {
          <div class="row" [class.static]="!r.changed" role="button" [attr.tabindex]="r.changed ? 0 : null"
               (click)="open(r)" (keydown.enter)="open(r)"
               [title]="r.changed ? 'Zur Stelle im Test springen' : 'Bestehender Test, nicht im PR: ' + r.warning.path + ':' + r.warning.line">
            <span class="test"><app-symbol-badge kind="test" /> <span class="tname">{{ r.warning.testName }}</span></span>
            <span class="arrow">mockt</span>
            <button type="button" class="member" (click)="$event.stopPropagation(); segmentClick.emit(r.warning.segmentId)"
                    title="Zur geänderten Funktion springen">{{ r.warning.collaborator }}.{{ r.warning.member }}</button>
            <span class="where">{{ r.where }}</span>
          </div>
        }
      </section>
    }
  `,
  styles: `
    .box { border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--border)); border-radius: 8px; background: var(--bg-panel-2);
      margin-bottom: 16px; overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border); }
    .head-icon { color: var(--warn); }
    header b { color: var(--fg); font-weight: 600; flex: none; }
    .hint { color: var(--fg-dim); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row { display: grid; grid-template-columns: minmax(0, 2fr) auto minmax(0, 1fr) auto; align-items: center; gap: 4px 10px;
      padding: 6px 12px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12px; }
    .row:last-child { border-bottom: 0; }
    .row:hover { background: var(--bg-hover); }
    .row.static { cursor: default; }
    .test { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--fg); }
    .tname { font-family: var(--font-code); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row:not(.static):hover .tname { color: var(--accent-fg); }
    .arrow { color: var(--fg-dim); font-size: 11px; }
    .member { justify-self: start; max-width: 100%; padding: 1px 7px; border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent);
      border-radius: 5px; background: color-mix(in srgb, var(--warn) 10%, transparent); color: var(--warn); font: 11.5px var(--font-code);
      cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .member:hover { border-color: var(--warn); }
    .where { color: var(--fg-dim); font-size: 11px; white-space: nowrap; }
    @media (max-width: 900px) {
      .row { grid-template-columns: minmax(0, 1fr) auto; }
    }
  `,
})
export class MockWarnings {
  protected readonly store = inject(ReviewStore);
  /** The stub line of a changed test was clicked. */
  readonly lineClick = output<SpecLineTarget>();
  /** The mocked changed function was clicked (segment id). */
  readonly segmentClick = output<string>();

  protected readonly rows = computed((): WarningRow[] => {
    const segs = this.store.segments();
    return (this.store.bundle()?.analysis.mockWarnings ?? []).map((w) => ({
      warning: w,
      changed: segs.has(w.test),
      where: `${w.path.substring(w.path.lastIndexOf('/') + 1)}${w.line ? ':' + w.line : ''}`,
    }));
  });

  protected open(r: WarningRow): void {
    if (!r.changed) return;
    if (r.warning.line) {
      const segmentId = lineOwner(this.store.segments().values(), r.warning.path, r.warning.line, r.warning.test);
      this.lineClick.emit({ segmentId, line: r.warning.line, old: false });
    } else {
      this.segmentClick.emit(r.warning.test);
    }
  }
}
