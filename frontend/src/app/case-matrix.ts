import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { CaseMatrix, CaseRow } from './api';
import {
  KIND_LABELS,
  TemplatePart,
  cellText,
  coveredText,
  duplicateNote,
  firstExpected,
  matrixSummary,
  rowTip,
  templateParts,
} from './case-matrices';
import { boundaryNote } from './case-checks';
import { Icon } from './icon';
import { ReviewStore } from './review.store';

interface MatrixView {
  matrix: CaseMatrix;
  parts: TemplatePart[];
  /** index of the first expected column (the separator sits before it) */
  split: number;
  rows: { row: CaseRow; note: string | null; block: boolean }[];
  duplicates: number;
  /** Fall- und Effekt-Abgleich: boundaries in the code the tests reach, with the values the matrix lacks */
  boundaries: { text: string; missing: boolean; segmentId: string }[];
}

/**
 * Fallmatrix: near-identical tests (copied, one value changed) and parameterised tests as a table input → expected -
 * which cases are covered, which are the same case twice (or the same input with another expectation). The template
 * shows the shared code with the columns as slots. A row jumps to its test; an unchanged test opens the file view.
 */
@Component({
  selector: 'app-case-matrix',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="box">
      <header>
        <app-icon name="test" [size]="15" class="head-icon" />
        <b>Fallmatrix (ähnliche Tests)</b>
        <span class="hint">Eingabe → Erwartung – kopierte und parametrisierte Tests als Tabelle</span>
      </header>
      <p class="summary">
        <span class="total">{{ summary().text }}</span>
        @if (summary().warn; as w) {
          <span class="sep">·</span>
          <span class="warnsum" title="Gleiche Eingaben in mehreren Tests – derselbe Fall wird mehrfach geprüft">{{ w }}</span>
        }
      </p>
      @for (v of views(); track v.matrix.id) {
        @let m = v.matrix;
        <div class="matrix">
          <div class="mhead">
            <span class="mtitle" [title]="m.title">{{ m.title }}</span>
            <span class="kind">{{ kindLabels[m.kind] }}</span>
            @if (v.duplicates) {
              <span class="mwarn"><app-icon name="warning" [size]="11" /> {{ v.duplicates }} doppelt</span>
            }
            <span class="file" [title]="m.path">{{ fileOf(m.path) }}</span>
          </div>
          @if (m.template) {
            <button type="button" class="tpl-toggle" (click)="toggle(m.id)" [attr.aria-expanded]="isOpen(m.id)"
                    title="Der gemeinsame Code der Tests; ‹n› ist die Spalte n">
              <app-icon [name]="isOpen(m.id) ? 'chevronDown' : 'chevronRight'" [size]="11" /> Vorlage
            </button>
            @if (isOpen(m.id)) {
              <pre class="template"><code>@for (p of v.parts; track $index) {@if (p.column === null) {<span>{{ p.text }}</span>} @else {<span class="slot" [class.exp]="p.expected" [title]="m.columns[p.column]?.label ?? ''">{{ p.text }}</span>}}</code></pre>
            }
          }
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th class="tname">Test</th>
                  @for (c of m.columns; track $index) {
                    <th [class.exp]="c.role === 'expected'" [class.sep]="$index === v.split" [title]="(c.role === 'input' ? 'Eingabe: ' : 'Erwartung: ') + c.label">
                      <span class="slotno">‹{{ $index + 1 }}›</span> {{ c.label }}
                    </th>
                  }
                  <th class="note-head"></th>
                </tr>
              </thead>
              <tbody>
                @for (r of v.rows; track $index) {
                  <tr [class.dup]="r.row.duplicateOf != null" [class.contra]="r.row.contradicts" [class.unchanged]="!r.block"
                      tabindex="0" (click)="open(m, r.row)" (keydown.enter)="open(m, r.row)" [title]="tip(r.row, r.block)">
                    <td class="tname">{{ r.row.name }}</td>
                    @for (value of r.row.values; track $index) {
                      <td class="val" [class.sep]="$index === v.split" [class.missing]="value === null" [title]="value ?? 'nicht geprüft'">{{ cell(value) }}</td>
                    }
                    <td class="note">
                      @if (r.note) {
                        <app-icon name="warning" [size]="11" /> {{ r.note }}
                      }
                    </td>
                  </tr>
                }
              </tbody>
              @if (v.split > 0) {
                <tfoot>
                  <tr>
                    <td class="tname covered-lbl">geprüft</td>
                    @for (c of m.columns; track $index) {
                      <td class="covered" [class.sep]="$index === v.split" [title]="c.role === 'input' ? 'Abgedeckte Werte: ' + covered(c) : ''">{{ covered(c) }}</td>
                    }
                    <td></td>
                  </tr>
                </tfoot>
              }
            </table>
          </div>
          @for (b of v.boundaries; track $index) {
            <button type="button" class="bnote" [class.missing]="b.missing" (click)="segmentClick.emit(b.segmentId)"
                    title="Grenzwerte aus den Vergleichen im geprüften Code (statisch) – Klick: zum Code">
              <app-icon [name]="b.missing ? 'warning' : 'check'" [size]="11" /> {{ b.text }}
            </button>
          }
        </div>
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
    .summary .total { color: var(--fg); }
    .summary .sep { padding: 0 6px; color: var(--fg-dim); }
    .warnsum { color: var(--warn); font-weight: 600; }
    .matrix { border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .matrix:last-child { border-bottom: 0; }
    .mhead { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px 4px; min-width: 0; }
    .mtitle { color: var(--fg); font: 600 12px var(--font-code); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .kind { flex: none; padding: 0 6px; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--fg-muted); font-size: 10.5px; }
    .mwarn { flex: none; display: inline-flex; align-items: center; gap: 4px; color: var(--warn); font-size: 11px; font-weight: 600; }
    .file { margin-left: auto; flex: none; color: var(--fg-dim); font-size: 11px; }
    .tpl-toggle { display: inline-flex; align-items: center; gap: 4px; margin: 0 12px 4px; padding: 0; border: 0; background: none;
      color: var(--fg-dim); font: 11.5px var(--font-ui); cursor: pointer; }
    .tpl-toggle:hover { color: var(--accent-fg); }
    .template { margin: 0 12px 6px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-editor);
      color: var(--code-fg); font: 11.5px/1.5 var(--font-code); white-space: pre; overflow-x: auto; }
    .template code { font: inherit; }
    .slot { padding: 0 2px; border-radius: 3px; color: var(--accent-fg); background: color-mix(in srgb, var(--accent) 18%, transparent); font-weight: 600; }
    .slot.exp { color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
    .scroll { overflow-x: auto; margin: 0 12px; border: 1px solid var(--border); border-radius: 5px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { padding: 4px 10px; background: var(--bg-panel); border-bottom: 1px solid var(--border); color: var(--fg-dim);
      font: 600 11px var(--font-code); text-align: left; white-space: nowrap; }
    th.exp { color: var(--ok); }
    .slotno { color: var(--fg-dim); font-weight: 400; }
    td { padding: 3px 10px; border-bottom: 1px solid var(--border); color: var(--fg); vertical-align: baseline; white-space: nowrap;
      max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
    td.tname, th.tname { max-width: 320px; font: 12px var(--font-code); }
    th.tname { font-weight: 600; font-size: 11px; }
    td.val { font: 11.5px var(--font-code); }
    td.missing { color: var(--fg-dim); }
    .sep { border-left: 2px solid var(--border-strong); }
    td.note { color: var(--warn); font-size: 11px; }
    td.note app-icon { vertical-align: -1px; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: var(--bg-hover); }
    tbody tr:hover .tname { color: var(--accent-fg); }
    tbody tr.unchanged .tname { color: var(--fg-muted); }
    tbody tr.dup td { background: color-mix(in srgb, var(--warn) 9%, transparent); }
    tbody tr.contra td { background: color-mix(in srgb, var(--warn) 16%, transparent); }
    tbody tr.dup .tname { color: var(--warn); }
    tfoot td { border-bottom: 0; background: var(--bg-panel); color: var(--fg-muted); font: 11px var(--font-code); }
    td.covered-lbl { color: var(--fg-dim); font: 11px var(--font-ui); }
    .bnote { display: flex; align-items: center; gap: 5px; margin: 6px 12px 0; padding: 0; border: 0; background: none;
      color: var(--ok); font: 11.5px var(--font-ui); cursor: pointer; text-align: left; }
    .bnote.missing { color: var(--warn); }
    .bnote:hover { text-decoration: underline; }
  `,
})
export class CaseMatrixOverview {
  protected readonly store = inject(ReviewStore);
  /** A row of a changed test was clicked (segment id of the test). */
  readonly segmentClick = output<string>();

  protected readonly kindLabels = KIND_LABELS;
  /** Matrices whose template is expanded. */
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  protected readonly matrices = computed(() => this.store.bundle()?.analysis.caseMatrices ?? []);
  protected readonly summary = computed(() => matrixSummary(this.matrices()));

  protected readonly views = computed((): MatrixView[] => {
    const segs = this.store.segments();
    return this.matrices().map((matrix) => ({
      matrix,
      parts: templateParts(matrix),
      split: firstExpected(matrix),
      rows: matrix.rows.map((row) => ({ row, note: duplicateNote(matrix, row), block: !!row.segmentId && segs.has(row.segmentId) })),
      duplicates: matrix.rows.filter((r) => r.duplicateOf != null).length,
      boundaries: (matrix.boundaries ?? []).map((b) => ({
        text: boundaryNote(b, segs.get(b.segmentId)?.symbol ?? null),
        missing: b.missing.length > 0,
        segmentId: b.segmentId,
      })),
    }));
  });

  protected isOpen(id: string): boolean {
    return this.opened().has(id);
  }

  protected toggle(id: string): void {
    const next = new Set(this.opened());
    next.has(id) ? next.delete(id) : next.add(id);
    this.opened.set(next);
  }

  /** A changed test: jump to its code block; an unchanged one: the file view, at the block around its line if any. */
  protected open(m: CaseMatrix, row: CaseRow): void {
    if (row.segmentId && this.store.segments().has(row.segmentId)) {
      this.segmentClick.emit(row.segmentId);
      return;
    }
    const around = row.line == null ? null : this.segmentAround(m.path, row.line);
    if (around) {
      this.store.focusSegment.set(around);
    }
    this.store.select({ kind: 'file', path: m.path });
  }

  protected cell(value: string | null): string {
    return cellText(value);
  }

  protected covered(c: CaseMatrix['columns'][number]): string {
    return coveredText(c);
  }

  protected tip(row: CaseRow, block: boolean): string {
    return rowTip(row, block);
  }

  protected fileOf(path: string): string {
    return path.substring(path.lastIndexOf('/') + 1);
  }

  /** The smallest segment of the file whose lines enclose the line (e.g. the test class), else null. */
  private segmentAround(path: string, line: number): string | null {
    let best: { id: string; span: number } | null = null;
    for (const s of this.store.segments().values()) {
      if (s.path !== path || s.startLine == null || s.endLine == null || s.startLine > line || s.endLine < line) continue;
      const span = s.endLine - s.startLine;
      if (!best || span < best.span) best = { id: s.id, span };
    }
    return best?.id ?? null;
  }
}
