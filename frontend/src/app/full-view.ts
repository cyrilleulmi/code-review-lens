import { signal } from '@angular/core';

/**
 * Full screen for a diagram with its bars. The element is handed to the browser (Fullscreen API) and its owner gives
 * it the class `full` while `what()` is set: it then covers the page and the diagram takes all the room. Where the
 * browser refuses full screen (an embedded page), the class alone lets it fill the window. The button and Esc end it.
 *
 * T: what can be shown full screen in the element - one thing ('on'), or one of several parts that share its bars.
 */
export class FullView<T extends string = 'on'> {
  /** what is shown full screen; null = nothing */
  readonly what = signal<T | null>(null);
  /** the browser really went full screen with the element (it may refuse) */
  private entered = false;

  constructor(private readonly element: () => HTMLElement) {}

  toggle(what: T): void {
    if (this.what() === what) {
      this.close();
    } else {
      this.open(what);
    }
  }

  open(what: T): void {
    this.what.set(what);
    const el = this.element();
    if (document.fullscreenElement !== el && typeof el.requestFullscreen === 'function') {
      // refused (no permission): the element still fills the window
      el.requestFullscreen().catch(() => undefined);
    }
  }

  close(): void {
    if (this.what() == null) {
      return;
    }
    this.what.set(null);
    this.entered = false;
    if (document.fullscreenElement === this.element()) {
      void document.exitFullscreen();
    }
  }

  /** On `fullscreenchange`: the browser left full screen on its own (Esc, another element) - follow it. */
  sync(): void {
    if (document.fullscreenElement === this.element()) {
      this.entered = true;
    } else if (this.entered) {
      this.entered = false;
      this.what.set(null);
    }
  }
}
