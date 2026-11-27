import {
  ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, model, output, signal, untracked, viewChild,
} from '@angular/core';
import { Segment } from './api';
import { classOf, stepName } from './flow-classes';
import { FlowSequence, SequenceCall, callStack } from './flow-sequence';
import { Icon } from './icon';
import { t } from './i18n';
import { EDGE_COLORS, areaColor, areaLabel, areaOfSegment, edgeColorIndex } from './look';
import { MethodDetail, methodLabel, methodTooltip, returnType } from './method-detail';
import { ReviewStore } from './review.store';
import { Message, SEQUENCE_BUBBLE, SEQUENCE_HEAD, SEQUENCE_HEAD_BOX, SEQUENCE_ROW, labelWidth, sequenceLayout } from './sequence-layout';
import { scrollToShow } from './sequence-player';
import { fitZoom, wheelZoom, zoomAround, zoomToShow } from './zoom';

/** The longest signature of a row: it sets how far the lifelines stand apart, so it is shorter than in the flow diagram. */
const ROOM = 56;
/** Width of the list beside the diagram (unzoomed), and the margin of the diagram. */
const LIST_W = 360;
const CANVAS_MARGIN = 18;

/** Where a row of the sequence leads in the code: a step, at a line when one is known. */
export interface SequenceTarget {
  segmentId: string;
  line: number | null;
}

/**
 * The sequence of a data flow (flow-sequence.ts) in two forms side by side, row for row: on the left the calls as a
 * list, indented by who calls whom; on the right the sequence diagram - a lifeline per class, an arrow per call, a
 * bar while a step runs, and a dashed arrow back where a call gives something back. A call played back (`current`)
 * is emphasised in both, what comes later is faded; the diagram zooms out when the call does not fit into the view.
 */
@Component({
  selector: 'app-sequence-diagram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let l = layout();
    @let now = current();
    @let z = shownZoom();
    <div class="seq" #scroll [style.--seq-dur]="duration() + 'ms'" [class.playing]="now > 0" (wheel)="wheel($event)">
      <div class="list" [style.min-height.px]="l.height" [style.zoom]="z">
        <div class="list-head" [style.height.px]="head">
          <app-icon name="sequence" [size]="14" />
          <b>{{ t('Abfolge') }}</b>
          <span class="dim">{{ sequence().calls.length === 1 ? t('1 Aufruf') : t('{n} Aufrufe', { n: sequence().calls.length }) }}</span>
        </div>
        @for (m of l.messages; track m.row) {
          @let no = m.call?.no ?? 0;
          @if (m.ret) {
            <div class="row ret" role="button" tabindex="0" [style.height.px]="m.h"
                 [class.later]="laterBack(m)" [class.just]="justBack(m)" [title]="rowTitle(m)"
                 (click)="pick.emit(m.call!.end)" (keydown.enter)="rowKey($event, m.call!.end)" (keydown.space)="rowKey($event, m.call!.end)">
              <span class="idx"></span>
              <span class="indent" [style.width.px]="indent(m)"></span>
              <span class="ret-mark" [style.color]="color(m.call)">↩</span>
              <span class="ret-type">{{ m.label }}</span>
              <span class="ret-to">{{ t('an {name}', { name: fullName(m.to) }) }}</span>
            </div>
          } @else {
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
        }
      </div>
      <div class="canvas" [style.width.px]="l.width" [style.height.px]="l.height" [style.zoom]="z">
        <svg [attr.width]="l.width" [attr.height]="l.height" class="lines">
          <defs>
            @for (c of markers; track c) {
              <marker [attr.id]="'seq-arrow-' + c" viewBox="0 0 8 8" refX="7.2" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0 0.5 L8 4 L0 7.5 z" [style.fill]="colorOf(c)" />
              </marker>
              <marker [attr.id]="'seq-back-' + c" viewBox="0 0 8 8" refX="7.2" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0.5 0.5 L7.5 4 L0.5 7.5" fill="none" stroke-width="1.4" [style.stroke]="colorOf(c)" />
              </marker>
            }
          </defs>
          @for (life of l.lifelines; track life.key) {
            <line class="life" [class.idle]="now > 0 && !involved().has(life.key)" [attr.x1]="life.x" [attr.x2]="life.x" [attr.y1]="headBox + 8" [attr.y2]="l.height - 4" />
          }
          @for (a of l.activations; track $index) {
            <rect class="bar" [class.running]="now > 0 && a.start <= now && now <= a.end" [class.later]="now > 0 && a.start > now"
                  [attr.x]="a.x" [attr.y]="a.y1" width="10" [attr.height]="a.y2 - a.y1" rx="2" />
          }
          @for (m of l.messages; track m.row) {
            @let no = m.call?.no ?? 0;
            @if (m.ret) {
              <g class="msg ret" [class.later]="laterBack(m)" [class.just]="justBack(m)" [style.--c]="color(m.call)" (click)="pick.emit(m.call!.end)">
                <title>{{ rowTitle(m) }}</title>
                <path class="arrow" [attr.d]="m.d" [attr.marker-end]="'url(#seq-back-' + colorIndex(m.call) + ')'" />
                <text class="ret-label" [attr.x]="m.lx" [attr.y]="m.ly">↩ {{ m.label }}</text>
              </g>
            } @else {
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
              </g>
            }
          }
        </svg>
        <div class="heads" [style.height.px]="head">
          @for (life of l.lifelines; track life.key) {
            <button type="button" class="life-head" [class.active]="activeLines().has(life.key)" [class.target]="targetLine() === life.key"
                    [class.source]="sourceLine() === life.key" [class.idle]="now > 0 && !involved().has(life.key)"
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
    /* never taller than the editor below the bars of the flow: its scrollbars stay in view with it */
    .seq { display: flex; align-items: flex-start; max-height: min(78vh, calc(100vh - 210px)); min-height: 220px; overflow: auto;
      border: 1px solid var(--border); border-radius: 10px;
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
    /* the row of an arrow back: lower, what comes back and to whom */
    .row.ret { line-height: 24px; font-size: 11px; color: var(--fg-muted); }
    .row.ret .idx { line-height: 24px; }
    .ret-mark { flex: none; font-weight: 700; }
    .ret-type { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 11px/24px var(--font-code); color: var(--fg); }
    .ret-to { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-dim); }
    .row.ret.just { background: var(--bg-selected-soft); border-left-color: color-mix(in srgb, var(--accent) 60%, transparent); }
    .row.ret.just .ret-type { font-weight: 700; }
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
      border-radius: 7px; color: var(--fg); cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s, opacity 0.2s; }
    .life-head:hover { border-color: var(--accent); border-top-color: var(--area); }
    .life-head.active { border-color: color-mix(in srgb, var(--accent) 55%, var(--node-border)); border-top-color: var(--area); }
    /* playing: the two classes of the call stand out, the classes not running step back */
    .life-head.source { border-color: var(--accent); border-top-color: var(--area); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
    .life-head.target { border-color: var(--accent); border-top-color: var(--area); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent); font-weight: 700; }
    .life-head.idle { opacity: 0.45; }
    .cname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px var(--font-code); }
    .life { stroke: var(--diagram-line); stroke-width: 1; stroke-dasharray: 3 4; transition: opacity 0.2s; }
    .life.idle { opacity: 0.4; }
    .bar { fill: var(--bg-editor); stroke: var(--diagram-line); stroke-width: 1; transition: fill 0.2s, stroke 0.2s, opacity 0.2s; }
    .bar.running { fill: color-mix(in srgb, var(--accent) 32%, var(--bg-editor)); stroke: var(--accent); }
    .bar.later { opacity: 0.4; }
    .msg { cursor: pointer; transition: opacity 0.2s; }
    .msg.later { opacity: 0.35; }
    /* playing: the calls already made step back a little, so the current one stands out */
    .playing .msg:not(.current):not(.just):not(.later) { opacity: 0.7; }
    .arrow { fill: none; stroke: var(--c); stroke-width: 1.5; }
    .msg.http .arrow { stroke-dasharray: 5 3; }
    .msg.bridged .arrow { stroke-dasharray: 2 4; }
    .msg:hover .arrow, .msg.current .arrow { stroke-width: 2.4; }
    .msg.current .arrow { stroke-width: 3; }
    /* an arrow back: dashed and thinner, with what comes back */
    .msg.ret .arrow { stroke-width: 1.2; stroke-dasharray: 4 3; }
    .msg.ret.just .arrow { stroke-width: 2; }
    .ret-label { fill: var(--c); font: 500 10.5px var(--font-code); paint-order: stroke; stroke: var(--bg-panel-2); stroke-width: 4px; stroke-linejoin: round; }
    .msg.ret.just .ret-label { font-weight: 700; }
    .found { fill: var(--c); }
    .run { fill: none; stroke: var(--c); stroke-width: 7; stroke-linecap: round; opacity: 0.45; stroke-dasharray: 1; stroke-dashoffset: 0;
      animation: seq-draw calc(var(--seq-dur) * 0.6) ease-out; pointer-events: none; }
    .bubble { fill: var(--c); }
    .bubble-no { fill: var(--on-fill); font: 700 10px var(--font-ui); }
    .label { fill: var(--fg); font: 500 11px var(--font-code); paint-order: stroke; stroke: var(--bg-panel-2); stroke-width: 4px; stroke-linejoin: round; }
    .msg.current .label { font-weight: 700; }
    @media (prefers-reduced-motion: reduce) { .run { animation: none; } }
  `,
})
export class SequenceDiagram {
  private readonly store = inject(ReviewStore);
  private readonly injector = inject(Injector);
  readonly sequence = input.required<FlowSequence>();
  /** the call played back (its number); 0 = none: all calls are shown alike */
  readonly current = input(0);
  /** how long a call is shown while playing, in ms (the arrow is drawn in a part of it) */
  readonly duration = input(1300);
  /** how much of a method the rows show: its name or its signature */
  readonly detail = input<MethodDetail>('name');
  /** step number of every segment in the flow (the number in the bubbles, as in the flow diagram and the code) */
  readonly stepOf = input.required<Record<string, number>>();
  /** the zoom chosen (buttons and Ctrl + wheel); while playing the diagram may show less (shownZoom) */
  readonly zoom = model(1);
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
  /** arrow heads: one per colour of a connection, 0 = neutral */
  protected readonly markers = Array.from({ length: EDGE_COLORS + 1 }, (_, i) => i);
  /** Playing: the zoom that shows the current call whole (null = the zoom chosen). */
  private readonly playZoom = signal<number | null>(null);
  /** The zoom the diagram is shown at. */
  readonly shownZoom = computed(() => (this.current() > 0 ? this.playZoom() ?? this.zoom() : this.zoom()));

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
      (call) => returnType(segs.get(call.to)?.signature, ROOM),
    );
  });

  /** The calls running at the current one (itself included). */
  protected readonly running = computed(() => new Set(callStack(this.sequence().calls, this.current()).map((c) => c.no)));
  /** Lifelines with a step running at the current call, and the ones the current call goes from and to. */
  protected readonly activeLines = computed(() => {
    const now = this.current();
    return new Set(now > 0 ? this.layout().activations.filter((a) => a.start <= now && now <= a.end).map((a) => a.key) : []);
  });
  protected readonly targetLine = computed(() => {
    const now = this.current();
    return now > 0 ? this.layout().activations.find((a) => a.no === now)?.key ?? null : null;
  });
  protected readonly sourceLine = computed(() => {
    const now = this.current();
    const call = this.sequence().calls[now - 1];
    if (!call) {
      return null;
    }
    const seg = this.store.segments().get(call.from);
    return seg ? classOf(seg, this.store.componentBySegment().get(call.from)).key : null;
  });
  /** Playing: the lifelines that take part now - running, calling or called; the others step back. */
  protected readonly involved = computed(() => {
    const lines = new Set(this.activeLines());
    const source = this.sourceLine();
    if (source) {
      lines.add(source);
    }
    return lines;
  });

  constructor() {
    // Playing: keep the call in view - zoom out when caller and step called do not fit side by side, and scroll the
    // diagram itself (never the page around it) so its row and its arrow are seen
    effect(() => {
      const now = this.current();
      const chosen = this.zoom();
      const message = this.layout().messages.find((m) => !m.ret && m.call?.no === now);
      if (!message) {
        untracked(() => this.playZoom.set(null));
        return;
      }
      untracked(() => {
        const el = this.scroll().nativeElement;
        // what has to be seen: the arrow with its label, and the heads of the two classes it runs between
        const heads = this.layout().lifelines.filter((life) => life.key === this.sourceLine() || life.key === this.targetLine());
        const left = Math.min(message.x1, message.x2, message.lx, ...heads.map((h) => h.x - h.w / 2));
        const right = Math.max(message.x1, message.x2, message.lx + labelWidth(message.label), ...heads.map((h) => h.x + h.w / 2));
        // the list covers the left of the view: the arrow has to fit into the rest
        const zoom = zoomToShow({ x1: left, y1: 0, x2: right, y2: 0 }, el.clientWidth - LIST_W * chosen, el.clientHeight, chosen);
        this.playZoom.set(zoom);
        afterNextRender({ write: () => {
          const list = LIST_W * zoom;
          const at = (x: number) => (LIST_W + CANVAS_MARGIN + x) * zoom;
          const seenX = scrollToShow(el.scrollLeft + list, el.clientWidth - list, at(left), at(right), 40);
          el.scrollLeft = Math.max(0, seenX - list);
          // the heads cover the top of the view: the rows are seen below them; a row above and below stay in view
          const head = SEQUENCE_HEAD * zoom;
          const seenY = scrollToShow(el.scrollTop + head, el.clientHeight - head, message.top * zoom, (message.top + message.h) * zoom, SEQUENCE_ROW * zoom);
          el.scrollTop = Math.max(0, seenY - head);
        } }, { injector: this.injector });
      });
    });
  }

  /** Fits the width of list and diagram into the view (a long sequence is scrolled, not shrunk to nothing). */
  fit(): void {
    const el = this.scroll().nativeElement;
    this.zoom.set(fitZoom(LIST_W + 2 * CANVAS_MARGIN + this.layout().width, 1, el.clientWidth, Number.MAX_SAFE_INTEGER, 1.5));
  }

  /** Ctrl + wheel zooms around the pointer; the wheel alone scrolls. */
  protected wheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const el = this.scroll().nativeElement;
    const from = this.shownZoom();
    const to = wheelZoom(from, event.deltaY);
    const box = el.getBoundingClientRect();
    const left = zoomAround(el.scrollLeft, event.clientX - box.left, from, to);
    const top = zoomAround(el.scrollTop, event.clientY - box.top, from, to);
    this.zoom.set(to);
    this.playZoom.set(null);
    afterNextRender({ write: () => {
      el.scrollLeft = left;
      el.scrollTop = top;
    } }, { injector: this.injector });
  }

  /** Enter or Space on a row shows its call - on the row itself, not on the button inside it (that one jumps to the code). */
  protected rowKey(event: Event, no: number): void {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      this.pick.emit(no);
    }
  }

  /** Playing: the arrow back comes only after the last call made while its step runs. */
  protected laterBack(m: Message): boolean {
    const now = this.current();
    return now > 0 && now < m.call!.end;
  }

  /** Playing: the arrow back follows right after the current call (that call, or the last one made while its step ran). */
  protected justBack(m: Message): boolean {
    return this.current() > 0 && m.call!.end === this.current();
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

  /** The text of a step at the level of detail chosen: "update()" or its signature. */
  private textOf(seg: Segment | undefined): string {
    const symbol = seg ? seg.symbol ?? seg.path.substring(seg.path.lastIndexOf('/') + 1) : '';
    const callable = seg?.symbolKind === 'method' || seg?.symbolKind === 'function';
    return methodLabel(symbol.substring(symbol.lastIndexOf('.') + 1), callable, seg?.signature, this.detail(), ROOM);
  }

  /** The label of an arrow: what is called, for REST with the request. */
  private label(seg: Segment | undefined, call: SequenceCall | null): string {
    const label = this.textOf(seg);
    return call?.http ? `${label} · ${call.via}` : label;
  }

  /** The step in the list: "PlayerResource.update", at the signature level with its parameters and return type. */
  protected listName(segmentId: string): string {
    const full = this.fullName(segmentId);
    const seg = this.store.segments().get(segmentId);
    if (this.detail() === 'name' || !seg?.signature) {
      return full;
    }
    const dot = full.lastIndexOf('.');
    return full.substring(0, dot + 1) + this.textOf(seg);
  }

  protected rowTitle(m: Message): string {
    const call = m.call;
    if (!call) {
      return [t('Einstiegspunkt: {name}', { name: this.fullName(m.to) }), this.signatureOf(m.to)].filter((x) => x).join('\n');
    }
    if (m.ret) {
      return t('Rückgabe von Aufruf {no}: {to} gibt {type} an {from} zurück', {
        no: call.no, to: this.fullName(call.to), type: m.label, from: this.fullName(call.from),
      }) + '\n' + t('Nach dem letzten Aufruf, den {to} macht', { to: this.fullName(call.to) });
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
