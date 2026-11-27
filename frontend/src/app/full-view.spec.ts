import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullView } from './full-view';

/** The element the browser shows full screen, as the Fullscreen API reports it. */
function browserShows(el: unknown): void {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
}

function element(accepts = true) {
  return { requestFullscreen: vi.fn(() => (accepts ? Promise.resolve() : Promise.reject(new Error('not allowed')))) };
}

describe('FullView', () => {
  afterEach(() => {
    browserShows(null);
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
  });

  it('asks the browser for full screen and leaves it again with the same button', () => {
    const el = element();
    const exit = vi.fn(() => Promise.resolve());
    (document as { exitFullscreen?: unknown }).exitFullscreen = exit;
    const view = new FullView(() => el as unknown as HTMLElement);

    view.toggle('on');
    expect(view.what()).toBe('on');
    expect(el.requestFullscreen).toHaveBeenCalledTimes(1);

    browserShows(el);
    view.sync();
    view.toggle('on');
    expect(view.what()).toBeNull();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('switches between the parts of one element without leaving full screen', () => {
    const el = element();
    const view = new FullView<'graph' | 'sequence'>(() => el as unknown as HTMLElement);

    view.toggle('graph');
    browserShows(el);
    view.sync();
    view.toggle('sequence');

    expect(view.what()).toBe('sequence');
    expect(el.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('follows the browser when it leaves full screen on its own (Esc)', () => {
    const el = element();
    const view = new FullView(() => el as unknown as HTMLElement);
    view.open('on');
    browserShows(el);
    view.sync();

    browserShows(null);
    view.sync();

    expect(view.what()).toBeNull();
  });

  it('still fills the window when the browser refuses full screen, until it is closed', async () => {
    const el = element(false);
    const view = new FullView(() => el as unknown as HTMLElement);

    view.open('on');
    await Promise.resolve();
    // a change of full screen elsewhere on the page does not end it
    view.sync();
    expect(view.what()).toBe('on');

    view.close();
    expect(view.what()).toBeNull();
  });
});
