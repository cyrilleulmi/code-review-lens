import {
  ChangeDetectionStrategy, Component as NgComponent, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, linkedSignal, signal, untracked,
} from '@angular/core';
import { Component } from './api';
import { FRAME_PADDING, Layout, Rect, curvePath, frameAround, layoutFlow, packRows, routePath } from './flow-layout';
import { stepName } from './flow-classes';
import { FlowSequence, comesLater, flowSequence, playbackOf, sequenceKey } from './flow-sequence';
import { Icon } from './icon';
import { serverText, t } from './i18n';
import { areaColor } from './look';
import { ReviewStore } from './review.store';
import { SequenceControls } from './sequence-controls';
import { SequencePlayer, scrollToShow } from './sequence-player';
import { returnType } from './method-detail';
import { ZoomControls, fitZoom, wheelZoom, zoomAround, zoomToShow } from './zoom';
import { FullView } from './full-view';
import { Pan } from './pan';

const NO_SEQUENCE: FlowSequence = { entries: [], calls: [] };

interface Box {
  c: Component;
  x: number;
  y: number;
  /** as wide as the name of the component needs: never cut off */
  w: number;
  file: string;
}

/** The frame of a layer around its components. */
interface Frame extends Rect {
  id: string;
  label: string;
}

/** Margin of the drawing in its scroll container. */
const CANVAS_MARGIN = 14;

/** Width of a component: room for its whole name. */
function boxWidth(name: string): number {
  return Math.max(W, Math.round(CHROME + name.length * CHAR_W));
}

/** Room for the name of a layer in the head of its frame. */
function headWidth(label: string): number {
  return 40 + t(label).length * 8.5;
}

/** The layers from the outside in: who calls whom, roughly left to right. */
/** Labels in German, translated with t(). */
const AREAS: { id: string; label: string }[] = [
  { id: 'test', label: 'Tests' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'adapter-in', label: 'Adapter (eingehend)' },
  { id: 'api', label: 'Schnittstelle (API)' },
  { id: 'usecase', label: 'Use Cases' },
  { id: 'application', label: 'Application' },
  { id: 'logic', label: 'Logik' },
  { id: 'adapter-out', label: 'Adapter (ausgehend)' },
  { id: 'data', label: 'Daten & Infrastruktur' },
  { id: 'domain', label: 'Domäne' },
];
/** Smallest width of a component; a longer name makes it wider. */
const W = 196;
const H = 44;
/** Room in a component beside its name: padding, progress and focus button; a character of the name (12px code font). */
const CHROME = 84;
const CHAR_W = 7.3;
const GAP = 64;
const ROW = 14;
/** Distance between components side by side in a layer without connections, and between such layers. */
const LOOSE_GAP = 22;

/**
 * Overview of the whole change as components (classes / modules, template and styles included) with the calls
 * between them; REST calls from the frontend into the backend are drawn dashed. Every layer is a frame around its
 * components. Like the flow diagrams it is placed by the layout engine (flow-layout.ts): callers left of what they
 * call, few crossings, connections at right angles around the boxes - the components of a layer need not stand in
 * one column. The focus button of a component shows only it and everything it depends on.
 *
 * Abfolge: a data flow can be chosen and played back in the diagram - call by call a dot runs along the connection
 * from the calling component to the one called (flow-sequence.ts, sequence-player.ts).
 */
@NgComponent({
  selector: 'app-component-diagram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.full]': '!!full.what()',
    '(document:fullscreenchange)': 'full.sync()',
    '(document:keydown.escape)': 'full.close()',
    '(window:resize)': 'measure()',
  },
  imports: [Icon, Pan, SequenceControls, ZoomControls],
  template: `
    @let pb = playback();
    <div class="bar">
      <span class="count">{{ t('{n} von {total} Komponenten · {edges} Verbindungen', { n: boxes().length, total: all().length, edges: lines().length }) }}</span>
      @if (focusName(); as f) {
        <span class="focus-info"><app-icon name="focus" [size]="12" /> {{ t('Fokus:') }} <b>{{ f }}</b> {{ t('und ihre Abhängigkeiten') }}</span>
        <button type="button" class="ftool" (click)="focus.set(null)"><app-icon name="close" [size]="12" /> {{ t('Fokus aufheben') }}</button>
      }
      <span class="spacer"></span>
      @if (flows().length) {
        <label class="pick" [class.on]="!!flowId()" [title]="t('Einen Datenfluss im Diagramm abspielen: Aufruf für Aufruf von Komponente zu Komponente')">
          <app-icon name="sequence" [size]="13" /> {{ t('Abfolge') }}
          <select [value]="flowId() ?? ''" (change)="pickFlow($event)" [attr.aria-label]="t('Datenfluss für die Abfolge')">
            <option value="">{{ t('– Datenfluss wählen –') }}</option>
            @for (f of flows(); track f.id) {
              <option [value]="f.id" [selected]="f.id === flowId()">{{ f.title }}</option>
            }
          </select>
        </label>
      }
      @if (hasTests()) {
        <button type="button" class="ftool" [class.on]="showTests()" (click)="showTests.set(!showTests())"><app-icon name="test" [size]="12" /> Tests</button>
      }
      <button type="button" class="ftool" [class.on]="hideIsolated()" (click)="hideIsolated.set(!hideIsolated())"
              [title]="t('Komponenten ohne Aufrufbeziehung ausblenden')"><app-icon name="eyeOff" [size]="12" /> {{ t('Ohne Verbindung ausblenden') }}</button>
      <span class="legend"><i class="l-call"></i> {{ t('Aufruf') }} <i class="l-http"></i> REST/HTTP</span>
      <app-zoom-controls [zoom]="shownZoom()" (zoomChange)="setZoom($event)" (fit)="fit()" [full]="!!full.what()" (fullChange)="full.toggle('on')" />
    </div>
    @if (flowId()) {
      <div class="seq-bar">
        <app-sequence-controls [player]="player" [length]="sequence().calls.length">
          @if (currentCall(); as c) {
            <span class="who">{{ stepName(c.from) }}</span>
            <app-icon name="arrowRight" [size]="12" />
            <b class="who">{{ stepName(c.to) }}</b>
            @if (c.http) {
              <span class="via">HTTP {{ c.via }}</span>
            }
            @if (returnOf(c.to); as r) {
              <span class="via ret" [title]="t('Was der Aufruf zurückgibt: am Ende des Aufrufs, nach allen Aufrufen, die er selbst macht')">↩ {{ r }}</span>
            }
            @if (pb?.from && pb?.from === pb?.to) {
              <span class="via">{{ t('innerhalb der Komponente') }}</span>
            }
          }
        </app-sequence-controls>
        <button type="button" class="ftool" (click)="openFlow()" [title]="t('Den Datenfluss mit Diagramm, Abfolge und Code öffnen')">
          <app-icon name="flow" [size]="12" /> {{ t('Flow öffnen') }}
        </button>
        <button type="button" class="ftool" (click)="closeFlow()" [title]="t('Abfolge schliessen')" [attr.aria-label]="t('Abfolge schliessen')">
          <app-icon name="close" [size]="12" />
        </button>
      </div>
    }
    @if (boxes().length === 0) {
      <p class="empty">{{ t('Keine Komponenten mit Code-Änderungen.') }}</p>
    } @else {
      <div class="scroll" appPan [class.sequence]="!!flowId()" [class.playing]="!!pb" [style.--seq-dur]="player.duration() + 'ms'" (wheel)="wheel($event)">
        <div class="canvas" [style.width.px]="size().w" [style.height.px]="size().h" [style.zoom]="shownZoom()">
          @for (f of frames(); track f.id) {
            <div class="frame" [style.left.px]="f.x" [style.top.px]="f.y" [style.width.px]="f.w" [style.height.px]="f.h" [style.--area]="areaColor(f.id)">
              <span class="frame-head">{{ t(f.label) }}</span>
            </div>
          }
          <svg [attr.width]="size().w" [attr.height]="size().h" class="edges">
            <defs>
              <marker id="cd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
              </marker>
            </defs>
            @for (l of lines(); track l.key) {
              <path [attr.d]="l.d" class="edge" [class.http]="l.http" [class.hot]="hovered() === l.from || hovered() === l.to" [style.stroke]="l.color"
                    [class.seq-off]="!!flowId() && !flowPlayback().playedAt.has(l.key)" [class.seq-later]="edgeLater(l.key)"
                    [class.dim]="!!hovered() && hovered() !== l.from && hovered() !== l.to" [style.stroke-width]="l.width" marker-end="url(#cd-arrow)">
                <title>{{ l.title }}</title>
              </path>
            }
            <!-- playback: the connection of the current call is drawn again, on top -->
            @for (r of playbackRuns(); track r.no) {
              <path [attr.d]="r.d" class="seq-run" pathLength="1" [style.stroke]="r.color" />
            }
          </svg>
          <!-- playback: a dot runs along the connection of the current call, from the caller to the component called -->
          @for (r of playbackRuns(); track r.no) {
            <span class="seq-dot" aria-hidden="true" [style.offset-path]="r.motion" [style.color]="r.color"></span>
          }
          @for (b of boxes(); track b.c.id) {
            @let p = progress(b.c);
            <div class="node" role="button" tabindex="0" [style.left.px]="b.x" [style.top.px]="b.y" [style.width.px]="b.w" [style.height.px]="h"
                 [style.--area]="areaColor(b.c.area)"
                 [class.done]="p.total > 0 && p.ok === p.total" [class.root]="focus() === b.c.id" [class.dim]="!!hovered() && !related(b.c.id)"
                 [class.seq-off]="!!flowId() && !flowPlayback().reachedAt.has(b.c.id)" [class.seq-later]="boxLater(b.c.id)"
                 [class.seq-from]="pb?.from === b.c.id" [class.seq-to]="pb?.to === b.c.id" [class.seq-even]="!!pb && pb.no % 2 === 0"
                 [title]="b.c.paths.join('\\n')" (mouseenter)="hovered.set(b.c.id)" (mouseleave)="hovered.set(null)"
                 (click)="open(b)" (keydown.enter)="open(b)">
              <span class="txt">
                <span class="name">{{ b.c.name }}</span>
                <span class="file">{{ b.file }}</span>
              </span>
              @if (p.total > 0 && p.ok === p.total) {
                <app-icon name="checkAll" [size]="13" class="ok" />
              } @else {
                <span class="cnt">{{ p.ok }}/{{ p.total }}</span>
              }
              <button type="button" class="focus" [class.on]="focus() === b.c.id" (click)="toggleFocus(b.c.id, $event)"
                      [title]="focus() === b.c.id ? t('Fokus aufheben') : t('Nur diese Komponente und alles, wovon sie abhängt, zeigen')">
                <app-icon name="focus" [size]="12" />
              </button>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel-2); overflow: hidden; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; background: var(--bg-panel); border-bottom: 1px solid var(--border); font-size: 12px; }
    .count { color: var(--fg-muted); }
    .spacer { flex: 1; }
    .focus-info { display: inline-flex; align-items: center; gap: 5px; color: var(--accent-fg); }
    .focus-info b { color: var(--fg); }
    .legend { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-dim); font-size: 11px; margin-left: 6px; }
    .legend i { display: inline-block; width: 18px; border-top: 2px solid var(--fg-dim); }
    .legend i.l-http { border-top: 2px dashed var(--fg-dim); }
    .empty { color: var(--fg-muted); padding: 12px; margin: 0; }
    /* full screen (full-view.ts): the diagram with its bars covers the page */
    :host(.full) { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; border: 0; border-radius: 0; }
    :host(.full) .scroll { flex: 1; max-height: none; }
    /* never taller than the editor below the bars: its scrollbars stay in view with it */
    .scroll { overflow: auto; max-height: min(78vh, calc(100vh - 190px)); }
    .canvas { position: relative; margin: 14px; }
    .frame { position: absolute; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--area) 40%, var(--border)); border-radius: 12px;
      background: color-mix(in srgb, var(--area) 6%, transparent); }
    .frame-head { display: block; padding: 11px 14px 0; color: var(--area); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
    .edges { position: absolute; inset: 0; overflow: visible; color: var(--fg-dim); pointer-events: none; }
    .edge { pointer-events: stroke; }
    .edge { fill: none; stroke: var(--diagram-line); stroke-width: 1.5; transition: stroke 0.15s, opacity 0.15s; }
    .edge { opacity: 0.75; }
    .edge.http { stroke-dasharray: 5 3; }
    .edge.hot { opacity: 1; stroke-width: 2.6; }
    .edge.dim { opacity: 0.25; }
    .node { position: absolute; display: flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; box-sizing: border-box;
      background: color-mix(in srgb, var(--area) 7%, var(--bg-editor));
      border: 1px solid var(--node-border); border-left: 4px solid var(--area); border-radius: 8px; cursor: pointer; transition: border-color 0.15s, opacity 0.15s; }
    .node:hover { border-color: var(--accent); }
    /* accepted (counted without a place: everywhere): the outline in the accept colour, the left edge stays the layer's */
    .node.done { border-color: var(--ok-all); border-left-color: var(--area); }
    .node.root { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(53, 116, 240, 0.3); }
    .node.dim { opacity: 0.4; }
    .txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .name { font: 600 12px var(--font-code); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file { font-size: 10.5px; color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cnt { font-size: 10.5px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
    .ok { color: var(--ok-all-fg); }
    .focus { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--fg-dim); cursor: pointer; flex: none; }
    .focus:hover { background: var(--bg-hover); color: var(--fg); }
    .focus.on { color: var(--accent-fg); background: rgba(53, 116, 240, 0.18); }

    /* Abfolge: a data flow played back in the diagram */
    .pick { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 4px 0 8px; border: 1px solid transparent; border-radius: 5px; color: var(--fg-muted); }
    .pick.on { border-color: var(--accent); color: var(--fg); }
    .pick select { max-width: 280px; height: 20px; padding: 0 4px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-editor);
      color: var(--fg); font: inherit; text-overflow: ellipsis; cursor: pointer; }
    .pick select:focus-visible { outline: 1px solid var(--accent); }
    .seq-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 10px; background: var(--bg-panel); border-bottom: 1px solid var(--border); font-size: 12px; }
    .seq-bar app-sequence-controls { flex: 1; }
    /* a flow is chosen: the rest of the diagram steps back; playing: what the flow has not reached yet is faded */
    .sequence .node { transition: opacity 0.25s, border-color 0.15s, box-shadow 0.15s; }
    .sequence .seq-off { opacity: 0.22; }
    /* playing: the two components of the current call stand out, the rest of the flow steps back */
    .playing .node:not(.seq-from):not(.seq-to) { opacity: 0.45; }
    .playing .edge { opacity: 0.4; }
    .playing .seq-later, .playing .node.seq-later:not(.seq-from):not(.seq-to) { opacity: 0.25; }
    .playing .seq-off, .playing .node.seq-off:not(.seq-from):not(.seq-to) { opacity: 0.12; }
    .node.seq-from, .node.seq-to { z-index: 2; border-color: var(--accent); border-left-color: var(--area); outline: 1px solid var(--accent); outline-offset: -2px;
      background: color-mix(in srgb, var(--accent) 12%, var(--bg-editor)); }
    .node.seq-from { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
    .node.seq-to { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 40%, transparent), 0 4px 16px rgba(0, 0, 0, 0.35);
      animation: seq-arrive-a var(--seq-dur) ease-out; }
    /* two names for the same animation: it starts again when the next call arrives at the same component */
    .node.seq-to.seq-even { animation-name: seq-arrive-b; }
  `,
})
export class ComponentDiagram {
  protected readonly store = inject(ReviewStore);
  protected readonly t = t;
  protected readonly h = H;
  protected readonly areaColor = areaColor;
  protected readonly showTests = signal(false);
  protected readonly hideIsolated = signal(false);
  protected readonly focus = signal<string | null>(null);
  protected readonly hovered = signal<string | null>(null);
  private readonly injector = inject(Injector);
  /** The diagram with its bars, shown full screen. */
  protected readonly full = new FullView(() => this.host.nativeElement);
  /**
   * Zoom as chosen (buttons, Ctrl + wheel); null = not chosen: the whole diagram fits into the view (fitted), and
   * follows its size. While playing, the zoom that shows the current call whole.
   */
  protected readonly zoom = signal<number | null>(null);
  /** The room the diagram has: the width of its view and the height it may take at most. */
  private readonly room = signal({ w: 0, h: 0 });
  /** The zoom that shows the whole diagram (at most 100 %). */
  private readonly fitted = computed(() => {
    const { w, h } = this.size();
    const room = this.room();
    return fitZoom(w + 2 * CANVAS_MARGIN, h + 2 * CANVAS_MARGIN, room.w, room.h, 1);
  });
  private readonly chosen = computed(() => this.zoom() ?? this.fitted());
  private readonly playZoom = signal<number | null>(null);

  // ------------------------------------------------------------------ Abfolge: a data flow played back
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  protected readonly flows = computed(() =>
    (this.store.bundle()?.analysis.flows ?? []).map((f) => ({ ...f, title: serverText(f.title) })));
  /**
   * The data flow chosen for the playback; null = none. The choice holds for one analysis of one pull request: the
   * ids of the flows are numbered per analysis, the same id means another flow elsewhere (and after analysing anew).
   */
  protected readonly flowId = linkedSignal<string, string | null>({
    source: () => {
      const bundle = this.store.bundle();
      return bundle ? `${bundle.pr.provider}/${bundle.pr.owner}/${bundle.pr.repo}/${bundle.pr.number}@${bundle.analysis.generatedAt}` : '';
    },
    computation: () => null,
  });
  private readonly flow = computed(() => this.flows().find((f) => f.id === this.flowId()) ?? null);
  /** Its calls one after the other (flow-sequence.ts). */
  protected readonly sequence = computed(() => {
    const flow = this.flow();
    return flow ? flowSequence(flow.steps, flow.edges) : NO_SEQUENCE;
  });
  protected readonly player = new SequencePlayer(() => this.sequence().calls.length);
  protected readonly currentCall = computed(() => this.sequence().calls[this.player.index() - 1] ?? null);
  protected readonly shownZoom = computed(() => (this.player.index() > 0 ? this.playZoom() ?? this.chosen() : this.chosen()));
  private componentOf(segmentId: string): string | null {
    return this.store.componentBySegment().get(segmentId)?.id ?? null;
  }
  /** The chosen flow as the diagram plays it back: the components it runs through, its connections, and when it reaches them. */
  protected readonly flowPlayback = computed(() => playbackOf(this.sequence(), (id) => this.componentOf(id)));
  /**
   * The current call: the components it runs between and the connection it runs along (line undefined: a call
   * within a component, or a connection that is not shown).
   */
  protected readonly playback = computed(() => {
    const call = this.currentCall();
    const ends = call ? this.flowPlayback().ends[call.no - 1] : undefined;
    if (!call || !ends) {
      return null;
    }
    const { from, to } = ends;
    return { no: call.no, from, to, line: from !== to ? this.lines().find((l) => l.from === from && l.to === to) : undefined };
  });
  /** The connection the current call runs along, as a list of none or one: a new call draws a new line (and dot). */
  protected readonly playbackRuns = computed(() => {
    const p = this.playback();
    return p?.line ? [{ no: p.no, d: p.line.d, color: p.line.color, motion: `path('${p.line.d}')` }] : [];
  });

  protected readonly all = computed(() => this.store.bundle()?.analysis.components ?? []);
  protected readonly hasTests = computed(() => this.all().some((c) => c.area === 'test'));
  private readonly allEdges = computed(() => this.store.bundle()?.analysis.componentEdges ?? []);

  /** Components shown: without tests (unless switched on), focus = the component plus everything it reaches. */
  private readonly shown = computed(() => {
    let comps = this.all().filter((c) => this.showTests() || c.area !== 'test');
    const ids = new Set(comps.map((c) => c.id));
    const edges = this.allEdges().filter((e) => ids.has(e.from) && ids.has(e.to));
    const root = this.focus();
    if (root && ids.has(root)) {
      const reach = new Set([root]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const e of edges) {
          if (reach.has(e.from) && !reach.has(e.to)) {
            reach.add(e.to);
            grew = true;
          }
        }
      }
      comps = comps.filter((c) => reach.has(c.id));
    } else if (this.hideIsolated()) {
      const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
      comps = comps.filter((c) => connected.has(c.id));
    }
    const shownIds = new Set(comps.map((c) => c.id));
    return { comps, edges: edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to)) };
  });

  /** The layers that have a component shown, as columns of the sketch. */
  private readonly columns = computed(() => {
    const comps = this.shown().comps;
    let x = FRAME_PADDING.left;
    return AREAS.filter((a) => comps.some((c) => c.area === a.id)).map((a) => {
      const col = { ...a, x };
      x += Math.max(...comps.filter((c) => c.area === a.id).map((c) => boxWidth(c.name))) + FRAME_PADDING.left + FRAME_PADDING.right + GAP;
      return col;
    });
  });

  /**
   * The sketch, shown until the layout engine has answered (and kept if it cannot be loaded): one column per layer;
   * inside a column, components are ordered by the average row of their callers (fewer crossings).
   */
  private readonly sketch = computed<Box[]>(() => {
    const { comps, edges } = this.shown();
    const row = new Map<string, number>();
    const boxes: Box[] = [];
    for (const col of this.columns()) {
      const members = comps.filter((c) => c.area === col.id).sort((a, b) => a.name.localeCompare(b.name));
      const weight = (c: Component) => {
        const rows = edges.filter((e) => e.to === c.id && row.has(e.from)).map((e) => row.get(e.from)!);
        return rows.length ? rows.reduce((x, y) => x + y, 0) / rows.length : Number.MAX_SAFE_INTEGER;
      };
      members.sort((a, b) => weight(a) - weight(b));
      members.forEach((c, i) => {
        row.set(c.id, i);
        const code = c.paths.find((p) => !/\.(html?|s?css|less)$/.test(p)) ?? c.paths[0];
        const file = c.paths.map((p) => p.substring(p.lastIndexOf('/') + 1)).join(' · ');
        boxes.push({ c: { ...c, paths: [code, ...c.paths.filter((p) => p !== code)] }, x: col.x, y: FRAME_PADDING.top + i * (H + ROW), w: boxWidth(c.name), file });
      });
    }
    return boxes;
  });

  /** What the layout was computed for: the components shown, their layers and the connections. */
  private readonly layoutKey = computed(() =>
    this.sketch().map((b) => b.c.id + ':' + b.c.area).join(',') + '|' + this.shown().edges.map((e) => e.from + '>' + e.to).join(','));
  /** The layout of the engine with the key it was computed for; null until the first one arrives. */
  private readonly placed = signal<{ key: string; layout: Layout } | null>(null);
  private readonly auto = computed(() => {
    const placed = this.placed();
    return placed?.key === this.layoutKey() ? placed.layout : null;
  });

  /**
   * Layers without any connection: the layered layout has no place for them (it would stack them in its first
   * column), so they are packed in rows below it, their components side by side.
   */
  private readonly loose = computed(() => {
    const connected = new Set(this.shown().edges.flatMap((e) => [e.from, e.to]));
    return new Set(this.columns().filter((col) => !this.shown().comps.some((c) => c.area === col.id && connected.has(c.id))).map((col) => col.id));
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.player.destroy());
    // The room of the diagram, for the zoom that shows all of it: measured whenever the view changes size, and when
    // the diagram appears (it is not there while no component has changes).
    afterNextRender(() => {
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(this.host.nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
      this.measure();
    });
    effect(() => {
      if (this.boxes().length) {
        afterNextRender({ read: () => this.measure() }, { injector: this.injector });
      }
    });
    // Another flow (or another pull request, where none is chosen): the playback starts over.
    // The same calls computed again (the review was loaded anew) leave it where it is.
    const playing = computed(() => this.flowId() + '|' + sequenceKey(this.sequence()));
    effect(() => {
      playing();
      untracked(() => this.player.reset());
    });
    // Playing: a new call brings the components it runs between into view - zoomed out as far as needed to see both,
    // never further in than the zoom chosen - by scrolling the diagram, not the page.
    effect(() => {
      const pb = this.playback();
      const chosen = this.chosen();
      const el = untracked(() => this.scroller());
      // fitted into the view (the default), the whole diagram is in view anyway: nothing to bring into view
      if (!pb || !el || this.zoom() == null) {
        untracked(() => this.playZoom.set(null));
        return;
      }
      untracked(() => {
        const ends = this.boxes().filter((b) => b.c.id === pb.from || b.c.id === pb.to);
        if (!ends.length) {
          return;
        }
        const span = {
          x1: Math.min(...ends.map((b) => b.x)), y1: Math.min(...ends.map((b) => b.y)),
          x2: Math.max(...ends.map((b) => b.x + b.w)), y2: Math.max(...ends.map((b) => b.y)) + H,
        };
        // the view grows with the drawing up to its largest height
        const zoom = zoomToShow(span, el.clientWidth, Math.max(el.clientHeight, this.room().h), chosen);
        this.playZoom.set(zoom);
        afterNextRender({ write: () => {
          const at = (v: number) => (v + CANVAS_MARGIN) * zoom;
          el.scrollLeft = scrollToShow(el.scrollLeft, el.clientWidth, at(span.x1), at(span.x2));
          el.scrollTop = scrollToShow(el.scrollTop, el.clientHeight, at(span.y1), at(span.y2));
        } }, { injector: this.injector });
      });
    });
    // Let the layout engine place the connected part of the diagram whenever the components or connections shown change.
    effect(() => {
      const key = this.layoutKey();
      const loose = this.loose();
      const boxes = this.sketch().filter((b) => !loose.has(b.c.area));
      const edges = this.shown().edges;
      const frames = this.columns().filter((f) => !loose.has(f.id));
      untracked(() => {
        layoutFlow({
          boxes: boxes.map((b) => ({ key: 'b:' + b.c.id, w: b.w, h: H, frame: 'f:' + b.c.area })),
          // room for the name of the layer in the head of its frame
          frames: frames.map((f) => ({ key: 'f:' + f.id, minW: headWidth(f.label) })),
          edges: edges.map((e, i) => ({ id: 'e' + i, from: 'b:' + e.from, to: 'b:' + e.to })),
        }).then((layout) => {
          if (this.layoutKey() === key) {
            this.placed.set({ key, layout });
          }
        }).catch(() => {
          // the engine could not be loaded or failed: the sketch stays
        });
      });
    });
  }

  /** The scroll container of the drawing (none while there are no components). */
  private scroller(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('.scroll');
  }

  protected setZoom(zoom: number): void {
    this.zoom.set(zoom);
  }

  /** The whole diagram into the view (at most 100 %), as it starts: it then follows the size of the view. */
  protected fit(): void {
    this.zoom.set(null);
  }

  /**
   * How much room the diagram has: as wide as its view, as high as it may get at most (its max-height; full screen,
   * where it has none, the height it has).
   */
  protected measure(): void {
    const el = this.scroller();
    if (!el) {
      return;
    }
    const limit = parseFloat(getComputedStyle(el).maxHeight);
    const w = el.clientWidth;
    const h = Number.isFinite(limit) ? limit : el.clientHeight;
    const room = this.room();
    if (room.w !== w || room.h !== h) {
      this.room.set({ w, h });
    }
  }

  /** Ctrl + wheel zooms around the pointer; the wheel alone scrolls. */
  protected wheel(event: WheelEvent): void {
    const el = this.scroller();
    if ((!event.ctrlKey && !event.metaKey) || !el) {
      return;
    }
    event.preventDefault();
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

  /** What a call to this step gives back (its return type); null = nothing. */
  protected returnOf(segmentId: string): string | null {
    return returnType(this.store.segments().get(segmentId)?.signature);
  }

  /**
   * The diagram as it is drawn: a frame per layer around its components. Connected layers where the layout engine
   * put them, the layers without connection in rows below; before the engine has answered, the sketch.
   */
  private readonly arranged = computed<{ boxes: Box[]; frames: Frame[] }>(() => {
    const auto = this.auto();
    const sketch = this.sketch();
    const around = (boxes: Box[]) => frameAround(boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: H })));
    if (!auto) {
      return {
        boxes: sketch,
        frames: this.columns().map((col) => ({ id: col.id, label: col.label, ...around(sketch.filter((b) => b.c.area === col.id)) })),
      };
    }
    const loose = this.loose();
    const boxes: Box[] = [];
    const frames: Frame[] = [];
    for (const col of this.columns().filter((c) => !loose.has(c.id))) {
      const members = sketch.filter((b) => b.c.area === col.id).map((b) => ({ ...b, ...(auto.boxes.get('b:' + b.c.id) ?? { x: b.x, y: b.y }) }));
      boxes.push(...members);
      frames.push({ id: col.id, label: col.label, ...(auto.frames.get('f:' + col.id) ?? around(members)) });
    }
    // the layers without connection: components in up to three columns, the frames in rows as wide as the rest
    const pad = FRAME_PADDING;
    const packs = this.columns().filter((c) => loose.has(c.id)).map((col) => {
      const members = sketch.filter((b) => b.c.area === col.id);
      const columns = Math.min(members.length, members.length <= 4 ? 2 : 3);
      const rows = Math.ceil(members.length / columns);
      // every column as wide as its widest component
      const widths = Array.from({ length: columns }, (_, n) => Math.max(...members.filter((_, i) => i % columns === n).map((b) => b.w)));
      const starts = widths.map((_, n) => widths.slice(0, n).reduce((sum, w) => sum + w + LOOSE_GAP, 0));
      return {
        col, members, columns, starts,
        w: Math.max(headWidth(col.label), widths.reduce((sum, w) => sum + w + LOOSE_GAP, 0) - LOOSE_GAP + pad.left + pad.right),
        h: rows * (H + ROW) - ROW + pad.top + pad.bottom,
      };
    });
    const bottom = Math.max(0, ...frames.map((f) => f.y + f.h));
    const width = Math.max(900, ...frames.map((f) => f.x + f.w));
    packRows(packs, width, LOOSE_GAP).forEach((at, i) => {
      const { col, members, columns, starts, w, h } = packs[i];
      const y = at.y + (bottom ? bottom + LOOSE_GAP + 6 : 0);
      frames.push({ id: col.id, label: col.label, x: at.x, y, w, h });
      members.forEach((b, n) => boxes.push({
        ...b, x: at.x + pad.left + starts[n % columns], y: y + pad.top + Math.floor(n / columns) * (H + ROW),
      }));
    });
    return { boxes, frames };
  });

  protected readonly boxes = computed(() => this.arranged().boxes);
  protected readonly frames = computed(() => this.arranged().frames);

  protected readonly lines = computed(() => {
    const auto = this.auto();
    const byId = new Map(this.boxes().map((b) => [b.c.id, b]));
    return this.shown().edges
      .flatMap((e, i) => (byId.has(e.from) && byId.has(e.to) ? [{ e, i }] : []))
      .map(({ e, i }) => {
        const a = byId.get(e.from)!;
        const b = byId.get(e.to)!;
        const route = auto?.routes.get('e' + i);
        const d = route ? routePath(route) : curvePath({ x: a.x, y: a.y, w: a.w, h: H }, { x: b.x, y: b.y, w: b.w, h: H }).d;
        const width = 1.3 + Math.min(2.5, Math.log2(e.calls));
        const title = `${a.c.name} → ${b.c.name}: ${t(e.calls === 1 ? '{n} Aufruf' : '{n} Aufrufe', { n: e.calls })}${e.http ? t(' (über REST/HTTP)') : ''}`;
        // a connection takes the colour of the calling layer: frontend -> backend reads cyan, backend calls orange/...
        return { key: e.from + '>' + e.to, d, http: e.http, from: e.from, to: e.to, width, title, color: areaColor(a.c.area), route };
      });
  });

  protected readonly size = computed(() => {
    const frames = this.frames();
    const points = this.lines().flatMap((l) => l.route ?? []);
    return {
      w: Math.max(...frames.map((f) => f.x + f.w), ...points.map((p) => p.x), 0) + 24,
      h: Math.max(...frames.map((f) => f.y + f.h), ...points.map((p) => p.y), 0) + 12,
    };
  });

  protected readonly focusName = computed(() => this.all().find((c) => c.id === this.focus())?.name ?? null);

  protected progress(c: Component) {
    return this.store.progressOf(c.segmentIds.map((segmentId) => ({ segmentId, place: null })));
  }

  protected related(id: string): boolean {
    const h = this.hovered();
    return !h || h === id || this.shown().edges.some((e) => (e.from === h && e.to === id) || (e.to === h && e.from === id));
  }

  protected toggleFocus(id: string, event: Event): void {
    event.stopPropagation();
    this.focus.set(this.focus() === id ? null : id);
  }

  protected open(b: Box): void {
    this.store.select({ kind: 'file', path: b.c.paths[0] });
  }

  /** Chooses the data flow to play back (none: the diagram as it was). Its components must be in view: no focus. */
  protected pickFlow(event: Event): void {
    const id = (event.target as HTMLSelectElement).value || null;
    this.flowId.set(id);
    if (id) {
      this.focus.set(null);
    }
  }

  protected closeFlow(): void {
    this.flowId.set(null);
  }

  /** Opens the chosen data flow: its diagram, its sequence and its code. */
  protected openFlow(): void {
    const id = this.flowId();
    if (id) {
      this.store.select({ kind: 'flow', id });
    }
  }

  /** "PlayerResource.update": a step with its class, for the line that says which call is played. */
  protected stepName(segmentId: string): string {
    return stepName(this.store.segments().get(segmentId), segmentId);
  }

  /** Playing: the sequence comes to this component only later. */
  protected boxLater(id: string): boolean {
    return comesLater(this.flowPlayback().reachedAt, id, this.player.index());
  }

  /** Playing: no call has run along this connection ("from>to") yet. */
  protected edgeLater(key: string): boolean {
    return comesLater(this.flowPlayback().playedAt, key, this.player.index());
  }
}
