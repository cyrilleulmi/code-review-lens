import { ChangeDetectionStrategy, Component as NgComponent, computed, effect, inject, signal, untracked } from '@angular/core';
import { Component } from './api';
import { FRAME_PADDING, Layout, Rect, curvePath, frameAround, layoutFlow, packRows, routePath } from './flow-layout';
import { Icon } from './icon';
import { t } from './i18n';
import { areaColor } from './look';
import { ReviewStore } from './review.store';

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
 */
@NgComponent({
  selector: 'app-component-diagram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="bar">
      <span class="count">{{ t('{n} von {total} Komponenten · {edges} Verbindungen', { n: boxes().length, total: all().length, edges: lines().length }) }}</span>
      @if (focusName(); as f) {
        <span class="focus-info"><app-icon name="focus" [size]="12" /> {{ t('Fokus:') }} <b>{{ f }}</b> {{ t('und ihre Abhängigkeiten') }}</span>
        <button type="button" class="ftool" (click)="focus.set(null)"><app-icon name="close" [size]="12" /> {{ t('Fokus aufheben') }}</button>
      }
      <span class="spacer"></span>
      @if (hasTests()) {
        <button type="button" class="ftool" [class.on]="showTests()" (click)="showTests.set(!showTests())"><app-icon name="test" [size]="12" /> Tests</button>
      }
      <button type="button" class="ftool" [class.on]="hideIsolated()" (click)="hideIsolated.set(!hideIsolated())"
              [title]="t('Komponenten ohne Aufrufbeziehung ausblenden')"><app-icon name="eyeOff" [size]="12" /> {{ t('Ohne Verbindung ausblenden') }}</button>
      <span class="legend"><i class="l-call"></i> {{ t('Aufruf') }} <i class="l-http"></i> REST/HTTP</span>
    </div>
    @if (boxes().length === 0) {
      <p class="empty">{{ t('Keine Komponenten mit Code-Änderungen.') }}</p>
    } @else {
      <div class="scroll">
        <div class="canvas" [style.width.px]="size().w" [style.height.px]="size().h">
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
                    [class.dim]="!!hovered() && hovered() !== l.from && hovered() !== l.to" [style.stroke-width]="l.width" marker-end="url(#cd-arrow)">
                <title>{{ l.title }}</title>
              </path>
            }
          </svg>
          @for (b of boxes(); track b.c.id) {
            @let p = progress(b.c);
            <div class="node" role="button" tabindex="0" [style.left.px]="b.x" [style.top.px]="b.y" [style.width.px]="b.w" [style.height.px]="h"
                 [style.--area]="areaColor(b.c.area)"
                 [class.done]="p.total > 0 && p.ok === p.total" [class.root]="focus() === b.c.id" [class.dim]="!!hovered() && !related(b.c.id)"
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
    .scroll { overflow: auto; max-height: 78vh; }
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
}
