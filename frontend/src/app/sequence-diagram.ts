import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import { Segment } from './api';
import { classOf, stepName } from './flow-classes';
import { FlowSequence, SequenceCall, callStack } from './flow-sequence';
import { Icon } from './icon';
import { t } from './i18n';
import { EDGE_COLORS, areaColor, areaLabel, areaOfSegment, edgeColorIndex } from './look';
import { MethodDetail, MethodText, methodText, methodTooltip } from './method-detail';
import { ReviewStore } from './review.store';
import { Message, SEQUENCE_BUBBLE, SEQUENCE_DETAIL, SEQUENCE_HEAD, SEQUENCE_HEAD_BOX, SEQUENCE_ROW, sequenceLayout } from './sequence-layout';
import { scrollToShow } from './sequence-player';

/** The longest texts of a row: they set how far the lifelines stand apart, so they are shorter than in the flow diagram. */
const ROOM = { signature: 56, data: 60 };

/** Where a row of the sequence leads in the code: a step, at a line when one is known. */
export interface SequenceTarget {
  segmentId: string;
  line: number | null;
}

/**
 * The sequence of a data flow (flow-sequence.ts) in two forms side by side, row for row: on the left the calls as a
 * list, indented by who calls whom; on the right the sequence diagram - a lifeline per class, an arrow per call, a
 * bar while a step runs. A call played back (`current`) is emphasised in both, what comes later is faded.
 */
@Component({
  selector: 'app-sequence-diagram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let l = layout();
    @let now = current();
    <div class="seq" #scroll [style.--seq-dur]="duration() + 'ms'">
      <div class="list" [style.min-height.px]="l.height">
        <div class="list-head" [style.height.px]="head">
          <app-icon name="sequence" [size]="14" />
          <b>{{ t('Abfolge') }}</b>
          <span class="dim">{{ sequence().calls.length === 1 ? t('1 Aufruf') : t('{n} Aufrufe', { n: sequence().calls.length }) }}</span>
        </div>
        @for (m of l.messages; track m.row) {
          @let no = m.call?.no ?? 0;
          <div class="row" role="button" tabindex="0" [style.height.px]="m.h" [class.entry]="!m.call"
               [class.current]="!!m.call && no === now" [class.later]="now > 0 && no > now" [class.running]="running().has(no) && no !== now"
               [title]="rowTitle(m)" (click)="pick.emit(no)" (keydown.enter)="rowKey($event, no)" (keydown.space)="rowKey($event, no)">
            <span class="idx">{{ m.call ? no : '' }}</span>
            <span class="indent" [style.width.px]="indent(m)"></span>
            <span class="no" [style.background]="color(m.call)">{{ stepOf()[m.to] ?? '' }}</span>
            <span class="name">{{ listName(m.to) }}</span>
            @if (!m.call) {
              <span class="tag">{{ t('Einstieg') }}</span>
            } @else {
              @if (m.call.http) {
                <span class="tag http">HTTP</span>
              }
              @if (m.call.repeatOf != null) {
                <span class="tag">{{ t('erneut') }}</span>
              }
              @if (m.call.back) {
                <span class="tag">{{ t('Rückruf') }}</span>
              }
              @if (m.call.bridged) {
                <span class="tag">{{ t('überbrückt') }}</span>
              }
            }
            <span class="spacer"></span>
            <button type="button" class="jump" (click)="jump(m, $event)" [title]="jumpTitle(m)">
              @if (m.call?.line != null) {
                {{ t('Z. {line}', { line: m.call!.line }) }}
              } @else {
                <app-icon name="code" [size]="12" />
              }
            </button>
          </div>
        }
      </div>
      <div class="canvas" [style.width.px]="l.width" [style.height.px]="l.height">
        <svg [attr.width]="l.width" [attr.height]="l.height" class="lines">
          <defs>
            @for (c of markers; track c) {
              <marker [attr.id]="'seq-arrow-' + c" viewBox="0 0 8 8" refX="7.2" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0 0.5 L8 4 L0 7.5 z" [style.fill]="colorOf(c)" />
              </marker>
            }
          </defs>
          @for (life of l.lifelines; track life.key) {
            <line class="life" [attr.x1]="life.x" [attr.x2]="life.x" [attr.y1]="headBox + 8" [attr.y2]="l.height - 4" />
          }
          @for (a of l.activations; track $index) {
            <rect class="bar" [class.running]="now > 0 && a.start <= now && now <= a.end" [class.later]="now > 0 && a.start > now"
                  [attr.x]="a.x" [attr.y]="a.y1" width="10" [attr.height]="a.y2 - a.y1" rx="2" />
          }
          @for (m of l.messages; track m.row) {
            @let no = m.call?.no ?? 0;
            <g class="msg" [class.entry]="!m.call" [class.http]="m.call?.http" [class.bridged]="m.call?.bridged" [class.current]="!!m.call && no === now" [class.later]="now > 0 && no > now"
               [style.--c]="color(m.call)" (click)="pick.emit(no)">
              <title>{{ rowTitle(m) }}</title>
              @if (!m.call) {
                <circle class="found" [attr.cx]="m.x1" [attr.cy]="m.y + 7" r="3.5" />
              }
              <path class="arrow" [attr.d]="m.d" [attr.marker-end]="'url(#seq-arrow-' + colorIndex(m.call) + ')'" />
              @if (m.call && no === now) {
                <path class="run" [attr.d]="m.d" pathLength="1" />
              }
              <g [attr.transform]="'translate(' + m.lx + ' ' + m.ly + ')'">
                <rect class="bubble" x="0" y="-12" [attr.width]="bubble" height="16" rx="8" />
                <text class="bubble-no" [attr.x]="bubble / 2" y="0" text-anchor="middle">{{ stepOf()[m.to] ?? '' }}</text>
                <text class="label" [attr.x]="bubble + 5" y="0">{{ m.label }}</text>
              </g>
              @for (line of m.details; track $index) {
                <text class="detail" [attr.x]="m.dx" [attr.y]="m.dy + $index * detailLine">{{ line }}</text>
              }
            </g>
          }
        </svg>
        <div class="heads" [style.height.px]="head">
          @for (life of l.lifelines; track life.key) {
            <button type="button" class="life-head" [class.active]="activeLines().has(life.key)" [class.target]="targetLine() === life.key"
                    [style.left.px]="life.x - life.w / 2" [style.width.px]="life.w" [style.height.px]="headBox" [style.--area]="areaColor(life.area)"
                    [title]="headTitle(life)" (click)="openLifeline(life.key)">
              <span class="cname">{{ life.name }}</span>
            </button>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; margin: 0 0 20px; }
    .seq { display: flex; align-items: flex-start; max-height: 78vh; overflow: auto; border: 1px solid var(--border); border-radius: 10px;
      background: radial-gradient(circle at 1px 1px, var(--tint-dots) 1px, transparent 0) 0 0 / 16px 16px, var(--bg-panel-2); }

    /* the list: stays in view when the diagram is scrolled sideways */
    .list { position: sticky; left: 0; z-index: 3; flex: none; width: 360px; max-width: 46%; box-sizing: border-box;
      background: var(--bg-panel-2); border-right: 1px solid var(--border); }
    .list-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 7px; box-sizing: border-box; padding: 0 12px;
      background: var(--bg-panel); border-bottom: 1px solid var(--border); font-size: 12px; color: var(--fg); }
    .list-head .dim { color: var(--fg-dim); font-size: 11.5px; }
    /* a row is as high as its row of the diagram; its texts stand in the first part, beside the arrow */
    .row { display: flex; align-items: flex-start; gap: 6px; box-sizing: border-box; padding: 0 6px 0 4px; border-left: 3px solid transparent;
      cursor: pointer; font-size: 12px; line-height: 32px; transition: opacity 0.2s, background 0.15s; }
    .row > .no, .row > .tag { margin-top: 8px; }
    .row > .jump { margin-top: 6px; }
    .row:hover { background: var(--bg-hover); }
    .row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
    .row.running { border-left-color: color-mix(in srgb, var(--accent) 45%, transparent); }
    .row.current { background: var(--bg-selected); border-left-color: var(--accent); }
    .row.later { opacity: 0.45; }
    .idx { flex: none; width: 22px; text-align: right; color: var(--fg-dim); font-size: 10.5px; font-variant-numeric: tabular-nums; }
    .indent { flex: none; }
    .no { flex: none; display: inline-grid; place-items: center; min-width: 18px; height: 16px; border-radius: 8px; color: var(--on-fill);
      font-size: 10px; font-weight: 700; line-height: 1; }
    .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px var(--font-code); color: var(--fg); }
    .name, .idx { line-height: 32px; }
    .row.entry .name { font-weight: 700; }
    .tag { flex: none; padding: 0 5px; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--fg-muted); font-size: 10px; line-height: 14px; }
    .tag.http { border-color: color-mix(in srgb, var(--cat-violet) 55%, transparent); color: var(--cat-violet); font-weight: 600; letter-spacing: 0.04em; }
    .spacer { flex: 1; }
    .jump { flex: none; display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 5px; border: 0; border-radius: 4px;
      background: transparent; color: var(--fg-dim); font: 500 10.5px var(--font-code); cursor: pointer; white-space: nowrap; }
    .jump:hover { background: var(--bg-selected-soft); color: var(--fg); }

    /* the diagram */
    .canvas { position: relative; flex: none; margin: 0 18px; }
    .lines { position: absolute; left: 0; top: 0; display: block; }
    .heads { position: sticky; top: 0; z-index: 2; }
    .life-head { position: absolute; top: 8px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 0 10px;
      background: color-mix(in srgb, var(--area) 9%, var(--bg-editor)); border: 1px solid var(--node-border); border-top: 3px solid var(--area);
      border-radius: 7px; color: var(--fg); cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
    .life-head:hover { border-color: var(--accent); border-top-color: var(--area); }
    .life-head.active { border-color: color-mix(in srgb, var(--accent) 55%, var(--node-border)); border-top-color: var(--area); }
    .life-head.target { border-color: var(--accent); border-top-color: var(--area); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
    .cname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px var(--font-code); }
    .life { stroke: var(--diagram-line); stroke-width: 1; stroke-dasharray: 3 4; }
    .bar { fill: var(--bg-editor); stroke: var(--diagram-line); stroke-width: 1; transition: fill 0.2s, stroke 0.2s, opacity 0.2s; }
    .bar.running { fill: color-mix(in srgb, var(--accent) 32%, var(--bg-editor)); stroke: var(--accent); }
    .bar.later { opacity: 0.4; }
    .msg { cursor: pointer; transition: opacity 0.2s; }
    .msg.later { opacity: 0.35; }
    .arrow { fill: none; stroke: var(--c); stroke-width: 1.5; }
    .msg.http .arrow { stroke-dasharray: 5 3; }
    .msg.bridged .arrow { stroke-dasharray: 2 4; }
    .msg:hover .arrow, .msg.current .arrow { stroke-width: 2.4; }
    .found { fill: var(--c); }
    .run { fill: none; stroke: var(--c); stroke-width: 5; stroke-linecap: round; opacity: 0.4; stroke-dasharray: 1; stroke-dashoffset: 0;
      animation: seq-draw calc(var(--seq-dur) * 0.6) ease-out; pointer-events: none; }
    .bubble { fill: var(--c); }
    .bubble-no { fill: var(--on-fill); font: 700 10px var(--font-ui); }
    .label { fill: var(--fg); font: 500 11px var(--font-code); paint-order: stroke; stroke: var(--bg-panel-2); stroke-width: 4px; stroke-linejoin: round; }
    .msg.current .label { font-weight: 700; }
    .detail { fill: var(--fg-muted); font: 400 10px var(--font-code); paint-order: stroke; stroke: var(--bg-panel-2); stroke-width: 3px; stroke-linejoin: round; }
    @media (prefers-reduced-motion: reduce) { .run { animation: none; } }
  `,
})
export class SequenceDiagram {
  private readonly store = inject(ReviewStore);
  readonly sequence = input.required<FlowSequence>();
  /** the call played back (its number); 0 = none: all calls are shown alike */
  readonly current = input(0);
  /** how long a call is shown while playing, in ms (the arrow is drawn in a part of it) */
  readonly duration = input(1300);
  /** how much of a method the rows show: its name, its signature, or the signature with its data structures */
  readonly detail = input<MethodDetail>('name');
  /** step number of every segment in the flow (the number in the bubbles, as in the flow diagram and the code) */
  readonly stepOf = input.required<Record<string, number>>();
  /** a row was clicked: the number of its call (0 = the row of an entry point) */
  readonly pick = output<number>();
  /** jump to the code: the calling line of a call, an entry point, or the first step of a class */
  readonly open = output<SequenceTarget>();

  private readonly scroll = viewChild.required<ElementRef<HTMLElement>>('scroll');
  protected readonly t = t;
  protected readonly areaColor = areaColor;
  protected readonly head = SEQUENCE_HEAD;
  protected readonly headBox = SEQUENCE_HEAD_BOX;
  protected readonly bubble = SEQUENCE_BUBBLE;
  protected readonly detailLine = SEQUENCE_DETAIL;
  /** arrow heads: one per colour of a connection, 0 = neutral */
  protected readonly markers = Array.from({ length: EDGE_COLORS + 1 }, (_, i) => i);

  protected readonly layout = computed(() => {
    const segs = this.store.segments();
    const components = this.store.componentBySegment();
    const areas = this.store.areaBySegment();
    return sequenceLayout(
      this.sequence(),
      (id) => {
        const seg = segs.get(id);
        return seg ? { ...classOf(seg, components.get(id)), area: areaOfSegment(seg, areas) } : { key: id, name: id, area: null };
      },
      (id, call) => this.label(segs.get(id), call),
      (id) => this.textOf(segs.get(id)).data,
    );
  });

  /** The calls running at the current one (itself included). */
  protected readonly running = computed(() => new Set(callStack(this.sequence().calls, this.current()).map((c) => c.no)));
  /** Lifelines with a step running at the current call, and the one the current call goes to. */
  protected readonly activeLines = computed(() => {
    const now = this.current();
    return new Set(now > 0 ? this.layout().activations.filter((a) => a.start <= now && now <= a.end).map((a) => a.key) : []);
  });
  protected readonly targetLine = computed(() => {
    const now = this.current();
    return now > 0 ? this.layout().activations.find((a) => a.no === now)?.key ?? null : null;
  });

  constructor() {
    // keep the call played back in view: scroll the diagram itself, never the page around it
    effect(() => {
      const now = this.current();
      const message = this.layout().messages.find((m) => m.call?.no === now);
      if (!message) {
        return;
      }
      untracked(() => {
        const el = this.scroll().nativeElement;
        // the heads cover the top of the view: the rows are seen below them; a row above and below stay in view
        const seen = scrollToShow(el.scrollTop + SEQUENCE_HEAD, el.clientHeight - SEQUENCE_HEAD, message.top, message.top + message.h, SEQUENCE_ROW);
        el.scrollTop = Math.max(0, seen - SEQUENCE_HEAD);
      });
    });
  }

  /** Enter or Space on a row shows its call - on the row itself, not on the button inside it (that one jumps to the code). */
  protected rowKey(event: Event, no: number): void {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      this.pick.emit(no);
    }
  }

  /** Colour of a call: that of its connection in the flow (1..8); 0 = neutral, for entry points and calls around steps left out. */
  protected colorIndex(call: SequenceCall | null): number {
    return call && !call.bridged ? edgeColorIndex(call.edge) : 0;
  }

  protected colorOf(index: number): string {
    return index ? `var(--edge-${index})` : 'var(--fg-muted)';
  }

  protected color(call: SequenceCall | null): string {
    return this.colorOf(this.colorIndex(call));
  }

  /** The list is indented by who calls whom; deep sequences stop at a few levels so the names keep their room. */
  protected indent(m: Message): number {
    return m.call ? Math.min(m.call.depth + 1, 7) * 11 : 0;
  }

  /** "PlayerResource.update": the step with its class. */
  protected fullName(segmentId: string): string {
    return stepName(this.store.segments().get(segmentId), segmentId);
  }

  /** The texts of a step at the level of detail chosen: "update()", its signature, and the lines of its data structures. */
  private textOf(seg: Segment | undefined): MethodText {
    const symbol = seg ? seg.symbol ?? seg.path.substring(seg.path.lastIndexOf('/') + 1) : '';
    const callable = seg?.symbolKind === 'method' || seg?.symbolKind === 'function';
    return methodText(symbol.substring(symbol.lastIndexOf('.') + 1), callable, seg?.signature, this.detail(), this.store.typesById(), ROOM);
  }

  /** The label of an arrow: what is called, for REST with the request. */
  private label(seg: Segment | undefined, call: SequenceCall | null): string {
    const label = this.textOf(seg).label;
    return call?.http ? `${label} · ${call.via}` : label;
  }

  /** The step in the list: "PlayerResource.update", from the signature level on with its parameters and return type. */
  protected listName(segmentId: string): string {
    const full = this.fullName(segmentId);
    const seg = this.store.segments().get(segmentId);
    if (this.detail() === 'name' || !seg?.signature) {
      return full;
    }
    const dot = full.lastIndexOf('.');
    return full.substring(0, dot + 1) + this.textOf(seg).label;
  }

  protected rowTitle(m: Message): string {
    const call = m.call;
    if (!call) {
      return [t('Einstiegspunkt: {name}', { name: this.fullName(m.to) }), this.signatureOf(m.to)].filter((x) => x).join('\n');
    }
    return [
      t('Aufruf {no} von {total}: {from} ruft {to} auf', { no: call.no, total: this.sequence().calls.length, from: this.fullName(call.from), to: this.fullName(call.to) })
        + (call.line != null ? ' · ' + t('Zeile {line}', { line: call.line }) : ''),
      call.http ? 'HTTP ' + call.via : '',
      call.repeatOf != null ? (call.repeatOf > 0
        ? t('Erneuter Aufruf: Was daraus folgt, steht bei Aufruf {no}', { no: call.repeatOf })
        : t('Erneuter Aufruf des Einstiegspunkts: Was daraus folgt, steht oben')) : '',
      call.back ? t('Rückruf in einen Schritt, der noch läuft (Rekursion): wird nicht weiter verfolgt') : '',
      call.bridged ? t('Über entfernte Bereiche hinweg') : '',
      this.signatureOf(call.to),
    ].filter((x) => x).join('\n');
  }

  /** For the tooltip of a row: the declaration of the step as written and the types it names, in full. */
  private signatureOf(segmentId: string): string {
    return methodTooltip(this.store.segments().get(segmentId)?.signature, this.store.typesById());
  }

  protected jumpTitle(m: Message): string {
    return m.call
      ? (m.call.line != null ? t('Zur Aufrufstelle im Code springen') : t('Zum Code des Aufrufers springen'))
      : t('Zum Code des Einstiegspunkts springen');
  }

  /** To the code: the calling line of a call (in the caller), or the entry point. */
  protected jump(m: Message, event: Event): void {
    event.stopPropagation();
    this.open.emit(m.call ? { segmentId: m.call.from, line: m.call.line } : { segmentId: m.to, line: null });
  }

  protected headTitle(life: { name: string; area: string | null }): string {
    const area = areaLabel(life.area);
    return (area ? `${life.name} · ${area}` : life.name) + '\n' + t('Klick springt zum Code der Klasse');
  }

  /** To the code of a class: its first step in the sequence. */
  protected openLifeline(key: string): void {
    const { activations, messages } = this.layout();
    const first = activations.find((a) => a.key === key);
    if (first) {
      this.open.emit({ segmentId: messages[first.row].to, line: null });
    }
  }
}
