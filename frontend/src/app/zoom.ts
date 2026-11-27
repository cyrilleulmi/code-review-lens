import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from './icon';
import { t } from './i18n';

/**
 * Zoom of the diagrams (call graph, sequence diagram, component diagram): the factor the drawing is shown at, with
 * CSS `zoom` on the element that holds it - the scroll container keeps its size, its scrollbars follow the drawing.
 * The playback zooms out on its own when a call runs between boxes that do not fit into the view together
 * (zoomToShow), never further in than the zoom chosen.
 */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** The steps of the buttons; Ctrl + wheel zooms in between. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
}

/** The next step in (dir 1) or out (dir -1) from a zoom that may lie between two steps. */
export function zoomStep(zoom: number, dir: 1 | -1): number {
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < zoom - 0.001);
  return next ?? (dir > 0 ? ZOOM_MAX : ZOOM_MIN);
}

/** Ctrl + wheel: a notch of the wheel (deltaY ±100) zooms by about 15 %. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * 0.0015));
}

/** The zoom that shows content of width × height in a view of viewW × viewH, at most `max`. */
export function fitZoom(width: number, height: number, viewW: number, viewH: number, max = 1): number {
  if (width <= 0 || height <= 0 || viewW <= 0 || viewH <= 0) {
    return clampZoom(max);
  }
  return Math.max(ZOOM_MIN, Math.min(max, Math.floor(Math.min(viewW / width, viewH / height) * 100) / 100));
}

/** Where to scroll after zooming from `from` to `to` so the point under the pointer (`at`, in the view) stays put. */
export function zoomAround(scroll: number, at: number, from: number, to: number): number {
  return Math.max(0, ((scroll + at) * to) / from - at);
}

/** A stretch of a drawing (unzoomed px). */
export interface Span {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Playback: the zoom at which the stretch of a call (its caller and the step called, `span`) fits into the view with
 * `margin` around it - the zoom chosen when it fits, else as far out as needed (down to ZOOM_MIN).
 */
export function zoomToShow(span: Span, viewW: number, viewH: number, chosen: number, margin = 48): number {
  return Math.min(chosen, fitZoom(span.x2 - span.x1 + 2 * margin, span.y2 - span.y1 + 2 * margin, viewW, viewH, chosen));
}

/**
 * The buttons of the zoom: out, the factor (a click goes back to 100 %), in, and fit (the whole drawing into the
 * view) - and beside them the button for full screen (full-view.ts). The diagram holds the zoom and passes it in;
 * Ctrl + wheel on the diagram zooms as well.
 */
@Component({
  selector: 'app-zoom-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <button type="button" class="ftool icon" [disabled]="zoom() <= min" (click)="zoomChange.emit(step(-1))"
            [title]="t('Verkleinern (Strg + Mausrad)')" [attr.aria-label]="t('Verkleinern')">
      <app-icon name="zoomOut" [size]="13" />
    </button>
    <button type="button" class="ftool pct" (click)="zoomChange.emit(1)" [title]="t('Auf 100 % zurücksetzen')">{{ percent() }}</button>
    <button type="button" class="ftool icon" [disabled]="zoom() >= max" (click)="zoomChange.emit(step(1))"
            [title]="t('Vergrössern (Strg + Mausrad)')" [attr.aria-label]="t('Vergrössern')">
      <app-icon name="zoomIn" [size]="13" />
    </button>
    <button type="button" class="ftool icon" (click)="fit.emit()" [title]="t('Ganzes Diagramm einpassen')" [attr.aria-label]="t('Ganzes Diagramm einpassen')">
      <app-icon name="fit" [size]="13" />
    </button>
    @if (full() != null) {
      <button type="button" class="ftool icon" [class.on]="full()" [attr.aria-pressed]="full()" (click)="fullChange.emit(!full())"
              [title]="full() ? t('Vollbild beenden (Esc)') : t('Diagramm im Vollbild zeigen')" [attr.aria-label]="full() ? t('Vollbild beenden') : t('Vollbild')">
        <app-icon [name]="full() ? 'fullscreenExit' : 'fullscreen'" [size]="13" />
      </button>
    }
  `,
  styles: `
    :host { display: inline-flex; flex: none; align-items: center; gap: 1px; }
    .ftool.icon { padding: 0 5px; }
    .pct { min-width: 46px; justify-content: center; padding: 0 4px; font-variant-numeric: tabular-nums; }
  `,
})
export class ZoomControls {
  /** the zoom shown (during the playback the one it chose) */
  readonly zoom = input.required<number>();
  readonly zoomChange = output<number>();
  readonly fit = output<void>();
  /** the diagram is shown full screen (null: it has no full screen, no button) */
  readonly full = input<boolean | null>(null);
  readonly fullChange = output<boolean>();
  protected readonly t = t;
  protected readonly min = ZOOM_MIN;
  protected readonly max = ZOOM_MAX;

  protected percent(): string {
    return Math.round(this.zoom() * 100) + ' %';
  }

  protected step(dir: 1 | -1): number {
    return zoomStep(this.zoom(), dir);
  }
}
