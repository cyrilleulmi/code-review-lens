import { Directive, ElementRef, inject } from '@angular/core';

/** What a press must not start on: it is clicked, dragged or focused itself. */
export const PAN_BLOCKED = 'button, a, input, select, textarea, [role="button"], [tabindex], .node, .frame-head, .msg';
/** How far the pointer moves before a press becomes a pan (below that it stays a click). */
export const PAN_THRESHOLD = 4;

/**
 * Moves around in a diagram: press on an empty spot of the scrolling element and drag - it scrolls with the pointer
 * (mouse and pen; a finger scrolls it anyway, that is left to the browser). A press on a box, a button or a
 * connection that can be clicked is theirs. The element has the class `can-pan` while there is something to scroll
 * to (the cursor shows it) and `panning` while it is moved; the click that ends a pan is swallowed.
 */
export class Panner {
  private start: { x: number; y: number; left: number; top: number; id: number } | null = null;
  private moving = false;

  constructor(private readonly el: HTMLElement) {}

  /** There is more of the drawing than the view shows. */
  canPan(): boolean {
    return this.el.scrollWidth > this.el.clientWidth + 1 || this.el.scrollHeight > this.el.clientHeight + 1;
  }

  enter(): void {
    this.el.classList.toggle('can-pan', this.canPan());
  }

  down(event: PointerEvent): void {
    // what is pressed, if it is something inside the diagram that takes the press itself
    const taken = (event.target as Element | null)?.closest?.(PAN_BLOCKED);
    if (event.button !== 0 || event.pointerType === 'touch' || !this.canPan() || (taken && taken !== this.el && this.el.contains(taken))) {
      return;
    }
    this.start = { x: event.clientX, y: event.clientY, left: this.el.scrollLeft, top: this.el.scrollTop, id: event.pointerId };
  }

  move(event: PointerEvent): void {
    const start = this.start;
    if (!start || event.pointerId !== start.id) {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!this.moving) {
      if (Math.hypot(dx, dy) < PAN_THRESHOLD) {
        return;
      }
      this.moving = true;
      this.el.classList.add('panning');
      // text the press began to select, and the pointer stays ours when it leaves the element
      getSelection()?.removeAllRanges();
      try {
        this.el.setPointerCapture(start.id);
      } catch {
        // no capture (a pointer that is gone already): the pan ends when the pointer leaves
      }
    }
    this.el.scrollLeft = start.left - dx;
    this.el.scrollTop = start.top - dy;
  }

  up(): void {
    const moved = this.moving;
    this.start = null;
    this.moving = false;
    this.el.classList.remove('panning');
    if (moved) {
      // the click of this release belongs to the pan, not to what lies under the pointer
      const swallow = (click: Event) => click.stopPropagation();
      this.el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => this.el.removeEventListener('click', swallow, { capture: true }));
    }
  }
}

/** `appPan` on the scrolling element of a diagram: drag an empty spot to move around (Panner). */
@Directive({
  selector: '[appPan]',
  host: {
    '(pointerenter)': 'panner.enter()',
    '(pointerdown)': 'panner.down($event)',
    '(pointermove)': 'panner.move($event)',
    '(pointerup)': 'panner.up()',
    '(pointercancel)': 'panner.up()',
  },
})
export class Pan {
  protected readonly panner = new Panner(inject<ElementRef<HTMLElement>>(ElementRef).nativeElement);
}
