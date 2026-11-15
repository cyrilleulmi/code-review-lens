import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { AffectedTest, ExpectationChange, SetupImpact, SpecEntry, SpecFile, SpecStatus } from './api';
import { ExpectationMark, KIND_LABELS, expectationMarks, expectationTotals, expectationWarning } from './expectations';
import {
  affectedStatus, countUnchangedAffected, impactNotice, impactWarns, markerTitle, sortImpacts, unchangedAffected,
  unchangedAffectedText,
} from './setup-impact';
import { Icon } from './icon';
import { ReviewStore } from './review.store';

/** A line of a test to show: the segment of the test and the line in the new (or, old: in the base) file. */
export interface SpecLineTarget {
  segmentId: string;
  line: number;
  old: boolean;
}

interface SpecRow {
  entry: SpecEntry;
  /** removed entries: the segment holding the deleted lines (opened in the file view), else null */
  removedIn: string | null;
  /** unchanged and without a changed entry below it: hidden until «unveränderte anzeigen» */
  quiet: boolean;
  done: boolean;
  /** markers of changed expectations («Erwartung geändert», «deaktiviert», «3 → 1 Assertions», …) */
  marks: ExpectationMark[];
  /** some marker is a warning */
  warn: boolean;
  /** expectation changes to show when the markers are expanded */
  changes: ExpectationChange[];
  /** unchanged test whose setup, test data or helper changed (Wirkung von Setup und Testdaten), else null */
  affectedBy: SetupImpact[] | null;
}

interface SpecFileView {
  file: SpecFile;
  rows: SpecRow[];
  /** unchanged test cases (hidden by default) - without those affected by a setup change, which stay visible */
  unchanged: number;
  /** «3 unveränderte, aber betroffen»: unchanged tests whose setup changed; null when none */
  affected: string | null;
  /** «⚠ 2 Erwartungen geändert · 1 deaktiviert» for the file header, null when nothing to warn about */
  warning: string | null;
}

const MARKS: Record<SpecStatus, { mark: string; label: string }> = {
  added: { mark: '+', label: 'neu' },
  changed: { mark: '~', label: 'geändert' },
  renamed: { mark: '→', label: 'umbenannt' },
  removed: { mark: '−', label: 'entfernt' },
  unchanged: { mark: '', label: 'unverändert' },
};

const SUMMARY_ORDER: SpecStatus[] = ['added', 'changed', 'renamed', 'removed', 'unchanged'];

/** Shown even among unchanged entries: something about its expectations changed. */
function noteworthy(e: SpecEntry): boolean {
  return e.status !== 'unchanged' || (e.expectations?.length ?? 0) > 0;
}

/**
 * Spec-Diff: the test names of every changed test file as an outline (suite › suite › test), old against new
 * version - what behaviour the tests specify and what changed, before reading test code. Entries with a code block
 * jump to it; removed entries open the file view at the deleted lines. Tests whose expectations changed (assertion
 * changed, removed, weakened, test switched off) carry a warning marker that expands to the old/new assertions.
 * Changed setup blocks, fixtures and test helpers are listed with the tests they affect (Wirkung von Setup und
 * Testdaten); unchanged tests among them stay visible with the marker «Setup geändert».
 */
@Component({
  selector: 'app-spec-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="box">
      <header>
        <app-icon name="test" [size]="15" class="head-icon" />
        <b>Spezifikation (Testnamen)</b>
        <span class="hint">was die geänderten Tests festlegen – Testnamen der alten gegen die neue Version</span>
      </header>
      <p class="summary">
        @for (p of summary(); track p.status) {
          @if (!$first) {
            <span class="sep">·</span>
          }
          <span [class]="'s-' + p.status"><b>{{ p.mark }}{{ p.n }}</b> {{ p.label }}</span>
        } @empty {
          Keine Testfälle in den geänderten Testdateien erkannt.
        }
        @if (warning(); as w) {
          <span class="sep">·</span>
          <span class="warnsum" title="Bestehende Tests erwarten jetzt etwas anderes oder weniger, oder sind ausgeschaltet – musterbasiert erkannt (Assertions, Matcher, xit/skip/@Disabled)">{{ w }}</span>
        }
        @if (affectedSummary(); as a) {
          <span class="sep">·</span>
          <span class="warnsum" title="Unveränderte Tests, deren Setup, Testdaten oder Testhilfen der PR ändert – sie prüfen jetzt vielleicht etwas anderes">{{ a }}</span>
        }
      </p>
      @if (impacts().length) {
        <div class="impacts">
          <p class="ihead">Wirkung von Setup und Testdaten</p>
          @for (i of visibleImpacts(); track i.segmentId + '#' + i.name + '#' + i.line) {
            @let ikey = 'impact#' + i.segmentId + '#' + i.name + '#' + i.line;
            <div class="impact" [class.warn]="warns(i)">
              <button type="button" class="itoggle" (click)="toggleDetails(ikey, $event)" [attr.aria-expanded]="isExpanded(ikey)"
                      [title]="isExpanded(ikey) ? 'Betroffene Tests ausblenden' : 'Betroffene Tests zeigen'">
                <app-icon [name]="isExpanded(ikey) ? 'chevronDown' : 'chevronRight'" [size]="11" />
              </button>
              <app-icon [name]="warns(i) ? 'warning' : 'info'" [size]="12" class="iicon" />
              <button type="button" class="itext" [class.link]="hasSegment(i.segmentId)" (click)="openImpact(i)"
                      [title]="hasSegment(i.segmentId) ? 'Zum geänderten Setup bzw. zu den Testdaten springen' : ''">{{ notice(i) }}</button>
            </div>
            @if (isExpanded(ikey)) {
              <div class="iaffected">
                @for (t of i.affected; track t.path + '#' + t.line) {
                  <div class="atest" [class.link]="hasSegment(t.segmentId)"
                       [attr.role]="hasSegment(t.segmentId) ? 'button' : null" [attr.tabindex]="hasSegment(t.segmentId) ? 0 : null"
                       (click)="openAffected(t)" (keydown.enter)="openAffected(t)" [title]="t.path + ':' + t.line">
                    <span class="astatus" [class]="'astatus s-' + t.status">{{ statusOf(t) }}</span>
                    <span class="name">{{ t.name }}</span>
                    <span class="where">{{ fileOf(t.path) }}:{{ t.line }}</span>
                  </div>
                }
              </div>
            }
          }
          @if (quietImpacts() > 0) {
            <button type="button" class="more" (click)="quietImpactsShown.set(!quietImpactsShown())">
              {{ quietImpactsShown() ? 'nur Wirkung auf unveränderte Tests zeigen'
                : quietImpacts() + (quietImpacts() === 1 ? ' weitere Änderung wirkt' : ' weitere Änderungen wirken') + ' nur auf neue oder geänderte Tests' }}
            </button>
          }
        </div>
      }
      @for (f of files(); track f.file.path) {
        <button type="button" class="file-head" (click)="toggleFile(f.file.path)" [attr.aria-expanded]="isOpen(f.file.path)"
                [title]="f.file.path">
          <app-icon [name]="isOpen(f.file.path) ? 'chevronDown' : 'chevronRight'" [size]="12" />
          <app-icon name="file" [size]="13" class="file-icon" />
          <span class="fname">{{ fileOf(f.file.path) }}</span>
          <span class="dir">{{ dirOf(f.file.path) }}</span>
          @if (f.warning) {
            <span class="fwarn">{{ f.warning }}</span>
          }
          @if (f.affected) {
            <span class="fwarn" title="Unveränderte Tests dieser Datei, deren Setup, Testdaten oder Testhilfen der PR ändert">{{ f.affected }}</span>
          }
          @if (f.file.status === 'added') {
            <span class="ftag s-added">neue Datei</span>
          } @else if (f.file.status === 'removed') {
            <span class="ftag s-removed">gelöscht</span>
          } @else if (f.file.previousPath && f.file.previousPath !== f.file.path) {
            <span class="ftag s-renamed" [title]="'vorher: ' + f.file.previousPath">umbenannt</span>
          }
        </button>
        @if (isOpen(f.file.path)) {
          @if (!f.file.baseAvailable) {
            <p class="note"><app-icon name="info" [size]="12" /> Basisversion nicht verfügbar – nur neue Seite</p>
          }
          @for (r of visible(f); track $index) {
            @let e = r.entry;
            @let key = f.file.path + '#' + (e.line ?? 'o' + e.oldLine) + '#' + e.name;
            <div class="entry" [class]="'entry s-' + e.status + ' k-' + e.kind" [class.link]="clickable(r)" [class.done]="r.done"
                 [style.padding-left.px]="14 + e.depth * 18" [attr.role]="clickable(r) ? 'button' : null"
                 [attr.tabindex]="clickable(r) ? 0 : null" (click)="open(f.file, r)" (keydown.enter)="open(f.file, r)"
                 [title]="tooltip(r)">
              <span class="mark">{{ marks[e.status].mark }}</span>
              <span class="name">{{ e.name }}</span>
              @if (e.status === 'renamed' && e.previousName) {
                <span class="prev">vorher: {{ e.previousName }}</span>
              }
              @if (r.marks.length) {
                <button type="button" class="xmarks" [class.warn]="r.warn" [class.static]="!r.changes.length"
                        [attr.aria-expanded]="r.changes.length ? isExpanded(key) : null"
                        [title]="r.changes.length ? (isExpanded(key) ? 'Details ausblenden' : 'Alte und neue Assertions zeigen') : 'War schon in der Basisversion deaktiviert'"
                        (click)="toggleDetails(key, $event)" (keydown.enter)="$event.stopPropagation()">
                  @if (r.warn) {
                    <app-icon name="warning" [size]="11" />
                  }
                  @for (m of r.marks; track m.label) {
                    <span class="xmark" [class.warn]="m.warn">{{ m.label }}</span>
                  }
                  @if (r.changes.length) {
                    <app-icon [name]="isExpanded(key) ? 'chevronDown' : 'chevronRight'" [size]="10" />
                  }
                </button>
              }
              @if (r.affectedBy; as by) {
                <button type="button" class="xmarks warn setup-mark" [title]="markTitle(by)"
                        (click)="openImpact(by[0], $event)" (keydown.enter)="$event.stopPropagation()">
                  <app-icon name="warning" [size]="11" /> Setup geändert
                </button>
              }
              <span class="where">{{ e.line ?? e.oldLine }}</span>
              @if (r.done) {
                <app-icon name="check" [size]="12" class="ok" />
              }
            </div>
            @if (r.changes.length && isExpanded(key)) {
              <div class="xdetails" [style.padding-left.px]="38 + e.depth * 18">
                @for (c of r.changes; track $index) {
                  <div class="xchange">
                    <span class="xkind" [class.warn]="c.kind !== 'added' && c.kind !== 'enabled'">{{ kindLabels[c.kind] }}</span>
                    @if (c.oldText != null) {
                      <div class="xline del" [class.link]="clickable(r)" (click)="openLine(f.file, r, c.oldLine, true)"
                           [title]="clickable(r) ? 'Alte Zeile ' + c.oldLine + ' im Testcode zeigen' : 'Alte Zeile ' + c.oldLine">
                        <span class="xno">{{ c.oldLine }}</span><span class="xsign">−</span><code>{{ c.oldText }}</code>
                      </div>
                    }
                    @if (c.newText != null) {
                      <div class="xline add" [class.link]="clickable(r)" (click)="openLine(f.file, r, c.newLine, false)"
                           [title]="clickable(r) ? 'Zeile ' + c.newLine + ' im Testcode zeigen' : 'Zeile ' + c.newLine">
                        <span class="xno">{{ c.newLine }}</span><span class="xsign">+</span><code>{{ c.newText }}</code>
                      </div>
                    }
                  </div>
                }
                @if (r.entry.assertionsBefore != null && r.entry.assertionsAfter != null) {
                  <p class="xcount">Assertions: {{ r.entry.assertionsBefore }} vorher → {{ r.entry.assertionsAfter }} jetzt</p>
                }
              </div>
            }
          }
          @if (f.unchanged > 0) {
            <button type="button" class="more" (click)="toggleUnchanged(f.file.path)" [style.padding-left.px]="14">
              {{ showsUnchanged(f.file.path) ? 'unveränderte ausblenden' : f.unchanged + ' unveränderte anzeigen' }}
            </button>
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
    .summary b { font-weight: 600; }
    .summary .sep { padding: 0 6px; color: var(--fg-dim); }
    .summary .s-unchanged b { color: var(--fg); }
    .warnsum { color: var(--warn); font-weight: 600; }
    .file-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 12px; border: 0; border-bottom: 1px solid var(--border);
      background: var(--bg-panel); color: var(--fg-muted); font: 12px var(--font-ui); cursor: pointer; text-align: left; }
    .file-head:hover { color: var(--fg); }
    .file-icon { color: var(--fg-dim); }
    .fname { color: var(--fg); font-weight: 600; white-space: nowrap; }
    .dir { color: var(--fg-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .ftag { margin-left: auto; padding: 0 6px; border: 1px solid currentColor; border-radius: 4px; font-size: 10.5px; white-space: nowrap; }
    .fwarn { margin-left: auto; color: var(--warn); font-size: 11px; font-weight: 600; white-space: nowrap; }
    .fwarn + .ftag { margin-left: 6px; }
    .note { display: flex; align-items: center; gap: 6px; margin: 0; padding: 5px 14px; color: var(--warn); font-size: 11.5px;
      border-bottom: 1px solid var(--border); }
    .entry { display: flex; align-items: baseline; gap: 8px; padding-top: 3px; padding-bottom: 3px; padding-right: 12px;
      font: 12px var(--font-code); color: var(--fg); border-bottom: 1px solid var(--border); min-width: 0; }
    .entry.link { cursor: pointer; }
    .entry.link:hover { background: var(--bg-hover); }
    .entry.link:hover .name { color: var(--accent-fg); }
    .entry.k-suite .name { font-weight: 600; }
    .mark { flex: none; width: 10px; text-align: center; font-weight: 700; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .prev { color: var(--fg-dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .where { margin-left: auto; flex: none; color: var(--fg-dim); font: 11px var(--font-ui); }
    .ok { color: var(--ok); flex: none; }
    .xmarks { display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 0 6px; border: 1px solid var(--border-strong);
      border-radius: 4px; background: none; color: var(--fg-muted); font: 10.5px var(--font-ui); cursor: pointer; white-space: nowrap; }
    .xmarks.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent);
      background: color-mix(in srgb, var(--warn) 12%, transparent); }
    .xmarks:hover { border-color: var(--accent); }
    .xmarks.static { cursor: default; }
    .xmarks.static:hover { border-color: var(--border-strong); }
    .xmark { color: var(--fg-muted); }
    .xmark.warn { color: var(--warn); font-weight: 600; }
    .xmark + .xmark::before { content: '·'; padding-right: 5px; color: var(--fg-dim); font-weight: 400; }
    .xdetails { padding-top: 4px; padding-bottom: 6px; padding-right: 12px; border-bottom: 1px solid var(--border); background: var(--bg-panel); }
    .xchange { margin: 3px 0 5px; }
    .xkind { display: block; margin-bottom: 2px; color: var(--fg-muted); font: 10.5px var(--font-ui); }
    .xkind.warn { color: var(--warn); }
    .xline { display: flex; align-items: baseline; gap: 6px; padding: 1px 6px; border-radius: 3px; font: 11.5px var(--font-code); min-width: 0; }
    .xline code { font: inherit; white-space: pre-wrap; word-break: break-word; min-width: 0; }
    .xline.del { background: var(--del-bg); color: var(--del-fg); }
    .xline.del code { text-decoration: line-through; }
    .xline.add { background: var(--add-bg); color: var(--add-fg); }
    .xline.link { cursor: pointer; }
    .xline.link:hover { outline: 1px solid var(--accent); }
    .xno { flex: none; min-width: 3ch; text-align: right; color: var(--fg-dim); }
    .xsign { flex: none; font-weight: 700; }
    .xcount { margin: 4px 0 0; color: var(--fg-dim); font: 11px var(--font-ui); }
    .s-added, .s-added .mark { color: var(--add-fg); }
    .s-removed, .s-removed .mark { color: var(--del-fg); }
    .s-changed .mark, .summary .s-changed b { color: var(--spec-changed); }
    .s-renamed .mark, .summary .s-renamed b, .ftag.s-renamed { color: var(--spec-renamed); }
    .entry.s-added .name { color: var(--add-fg); }
    .entry.s-removed .name { color: var(--del-fg); text-decoration: line-through; }
    .entry.s-unchanged { color: var(--fg-dim); }
    .entry.s-unchanged .name { color: var(--fg-dim); }
    .more { display: block; width: 100%; padding-top: 4px; padding-bottom: 4px; border: 0; border-bottom: 1px solid var(--border);
      background: none; color: var(--fg-dim); font: 11.5px var(--font-ui); cursor: pointer; text-align: left; }
    .more:hover { color: var(--accent-fg); }
    .impacts { border-bottom: 1px solid var(--border); padding: 4px 0; }
    .ihead { margin: 0; padding: 2px 12px 4px; color: var(--fg-dim); font-size: 11px; }
    .impact { display: flex; align-items: center; gap: 6px; padding: 2px 12px; color: var(--fg-muted); font-size: 12px; min-width: 0; }
    .impact.warn { color: var(--warn); }
    .iicon { flex: none; }
    .itoggle { flex: none; display: inline-flex; padding: 0; border: 0; background: none; color: var(--fg-dim); cursor: pointer; }
    .itoggle:hover { color: var(--accent-fg); }
    .itext { padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: default;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .impact.warn .itext { font-weight: 600; }
    .itext.link { cursor: pointer; }
    .itext.link:hover { color: var(--accent-fg); text-decoration: underline; }
    .iaffected { padding: 2px 12px 6px 44px; }
    .atest { display: flex; align-items: baseline; gap: 8px; padding: 1px 0; font: 11.5px var(--font-code); color: var(--fg); min-width: 0; }
    .atest.link { cursor: pointer; }
    .atest.link:hover .name { color: var(--accent-fg); }
    .astatus { flex: none; min-width: 9ch; color: var(--fg-dim); font: 10.5px var(--font-ui); }
    .astatus.s-unchanged { color: var(--warn); font-weight: 600; }
    .impacts .more { border-bottom: 0; padding-left: 12px; }
    .setup-mark { cursor: pointer; }
    .box > :last-child { border-bottom: 0; }
  `,
})
export class SpecOverview {
  protected readonly store = inject(ReviewStore);
  /** An entry with a code block was clicked (segment id). */
  readonly segmentClick = output<string>();
  /** A line of an assertion was clicked: show that line of the test's code block. */
  readonly lineClick = output<SpecLineTarget>();

  protected readonly marks = MARKS;
  protected readonly kindLabels = KIND_LABELS;
  /** Files whose outline is collapsed (all start open). */
  private readonly closed = signal<ReadonlySet<string>>(new Set());
  /** Files that show their unchanged entries too. */
  private readonly unchangedShown = signal<ReadonlySet<string>>(new Set());
  /** Entries whose expectation details are expanded. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Setup impacts that reach only new or changed tests are shown too. */
  protected readonly quietImpactsShown = signal(false);

  /** Wirkung von Setup und Testdaten: those reaching unchanged tests first. */
  protected readonly impacts = computed(() => sortImpacts(this.store.setupImpacts()));
  protected readonly visibleImpacts = computed(() =>
    this.quietImpactsShown() ? this.impacts() : this.impacts().filter((i) => impactWarns(i)));
  /** Impacts that reach only new or changed tests (behind «n weitere …»). */
  protected readonly quietImpacts = computed(() => this.impacts().filter((i) => !impactWarns(i)).length);
  /** «3 unveränderte, aber betroffen» over all files (also existing test files); null when none. */
  protected readonly affectedSummary = computed(() => unchangedAffectedText(countUnchangedAffected(this.store.setupImpacts())));

  /** Tooltip of the marker «Setup geändert» on an unchanged test. */
  protected markTitle(by: SetupImpact[]): string {
    return markerTitle(by) + (this.hasSegment(by[0].segmentId) ? '\nKlick: zum geänderten Setup springen' : '');
  }

  /** path -> line key -> segment id, to find the deleted lines of a removed entry. */
  private readonly keysByPath = computed(() => {
    const result = new Map<string, Map<string, string>>();
    for (const s of this.store.segments().values()) {
      let keys = result.get(s.path);
      if (!keys) {
        keys = new Map();
        result.set(s.path, keys);
      }
      for (const k of s.lineKeys) {
        keys.set(k, s.id);
      }
    }
    return result;
  });

  protected readonly files = computed((): SpecFileView[] => {
    const segs = this.store.segments();
    const affected = unchangedAffected(this.store.setupImpacts());
    return (this.store.bundle()?.analysis.specs ?? []).map((file) => {
      const entries = file.entries;
      const byLine = affected.get(file.path);
      // unchanged tests whose setup changed stay visible among the unchanged ones
      const affectedBy = (e: SpecEntry) =>
        e.kind === 'test' && e.status === 'unchanged' && e.line != null ? byLine?.get(e.line) ?? null : null;
      const shown = (e: SpecEntry) => noteworthy(e) || !!affectedBy(e);
      const rows = entries.map((entry, i): SpecRow => {
        let quiet = !shown(entry);
        if (quiet && entry.kind === 'suite') {
          // a suite stays visible as long as something below it changed
          for (let j = i + 1; j < entries.length && entries[j].depth > entry.depth; j++) {
            if (shown(entries[j])) {
              quiet = false;
              break;
            }
          }
        }
        const segmentId = entry.segmentId && segs.has(entry.segmentId) ? entry.segmentId : null;
        const p = segmentId ? this.store.progressOf([{ segmentId, place: null }]) : null;
        const marks = expectationMarks(entry);
        return {
          entry,
          removedIn: entry.status === 'removed' ? this.deletedIn(file.path, entry.oldLine) : null,
          quiet,
          done: !!p && p.total > 0 && p.ok === p.total,
          marks,
          warn: marks.some((m) => m.warn),
          changes: entry.expectations ?? [],
          affectedBy: affectedBy(entry),
        };
      });
      const unchanged = entries.filter((e) => e.kind === 'test' && !shown(e)).length;
      const affectedText = unchangedAffectedText(entries.filter((e) => !!affectedBy(e)).length);
      return { file, rows, unchanged, affected: affectedText, warning: expectationWarning(expectationTotals([file])) };
    });
  });

  /** Test cases per status over all files (suites are structure, they do not count). */
  protected readonly summary = computed(() => {
    const counts = new Map<SpecStatus, number>();
    for (const f of this.files()) {
      for (const e of f.file.entries) {
        if (e.kind === 'test') {
          counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
        }
      }
    }
    return SUMMARY_ORDER.filter((s) => counts.get(s)).map((status) => ({
      status,
      n: counts.get(status)!,
      mark: status === 'unchanged' ? '' : MARKS[status].mark,
      label: MARKS[status].label,
    }));
  });

  /** «⚠ 2 Erwartungen geändert · 1 deaktiviert» over all files, null when nothing to warn about. */
  protected readonly warning = computed(() => expectationWarning(expectationTotals(this.files().map((f) => f.file))));

  protected visible(f: SpecFileView): SpecRow[] {
    return this.showsUnchanged(f.file.path) ? f.rows : f.rows.filter((r) => !r.quiet);
  }

  protected clickable(r: SpecRow): boolean {
    return !!(r.entry.segmentId && this.store.segments().has(r.entry.segmentId)) || !!r.removedIn;
  }

  protected open(file: SpecFile, r: SpecRow): void {
    const id = r.entry.segmentId;
    if (id && this.store.segments().has(id)) {
      this.segmentClick.emit(id);
    } else if (r.removedIn) {
      // removed test: the file view shows the deleted lines in their block
      this.store.focusSegment.set(r.removedIn);
      this.store.select({ kind: 'file', path: file.path });
    }
  }


  protected warns(i: SetupImpact): boolean {
    return impactWarns(i);
  }

  protected notice(i: SetupImpact): string {
    return impactNotice(i);
  }

  protected statusOf(t: AffectedTest): string {
    return affectedStatus(t);
  }

  protected hasSegment(id: string | null): boolean {
    return !!id && this.store.segments().has(id);
  }

  /** The changed setup block / fixture / helper: jump to its code. */
  protected openImpact(i: SetupImpact, event?: Event): void {
    event?.stopPropagation();
    if (this.hasSegment(i.segmentId)) {
      this.segmentClick.emit(i.segmentId);
    }
  }

  /** An affected test with changed lines: jump to it (unchanged tests have no block). */
  protected openAffected(t: AffectedTest): void {
    if (t.segmentId && this.hasSegment(t.segmentId)) {
      this.segmentClick.emit(t.segmentId);
    }
  }

  /** An old/new assertion line: show it in the test's code block (or at least the block). */
  protected openLine(file: SpecFile, r: SpecRow, line: number | null, old: boolean): void {
    const id = r.entry.segmentId;
    if (id && this.store.segments().has(id) && line != null) {
      this.lineClick.emit({ segmentId: id, line, old });
    } else {
      this.open(file, r);
    }
  }

  protected isExpanded(key: string): boolean {
    return this.expanded().has(key);
  }

  protected toggleDetails(key: string, event: Event): void {
    event.stopPropagation();
    this.expanded.set(toggled(this.expanded(), key));
  }

  protected tooltip(r: SpecRow): string {
    const e = r.entry;
    const path = [...e.suites, e.name].join(' › ');
    const status = MARKS[e.status].label;
    const where = e.status === 'removed' ? `alte Zeile ${e.oldLine}` : `Zeile ${e.line}`;
    const action = this.clickable(r) ? (e.status === 'removed' ? ' – in der Dateiansicht zeigen' : ' – zum Testcode springen') : '';
    const asserts = e.kind !== 'test' ? ''
      : e.assertionsBefore != null && e.assertionsAfter != null ? `\n${e.assertionsBefore} → ${e.assertionsAfter} Assertions`
      : e.assertionsAfter != null ? `\n${e.assertionsAfter} Assertions`
      : e.assertionsBefore != null ? `\n${e.assertionsBefore} Assertions (entfernt)` : '';
    return `${path}\n${status} · ${where}${action}${asserts}`;
  }

  protected isOpen(path: string): boolean {
    return !this.closed().has(path);
  }

  protected toggleFile(path: string): void {
    this.closed.set(toggled(this.closed(), path));
  }

  protected showsUnchanged(path: string): boolean {
    return this.unchangedShown().has(path);
  }

  protected toggleUnchanged(path: string): void {
    this.unchangedShown.set(toggled(this.unchangedShown(), path));
  }

  protected fileOf(path: string): string {
    return path.substring(path.lastIndexOf('/') + 1);
  }

  protected dirOf(path: string): string {
    return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
  }

  /** The segment that owns the first deleted line of a removed entry (its start line, or the next two lines). */
  private deletedIn(path: string, oldLine: number | null): string | null {
    const keys = this.keysByPath().get(path);
    if (!keys || oldLine == null) return null;
    for (let line = oldLine; line <= oldLine + 2; line++) {
      const id = keys.get(`O${line}`);
      if (id) return id;
    }
    return null;
  }
}

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  next.has(value) ? next.delete(value) : next.add(value);
  return next;
}
