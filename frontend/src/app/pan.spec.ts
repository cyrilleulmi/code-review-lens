import { describe, expect, it, vi } from 'vitest';
import { PAN_THRESHOLD, Panner } from './pan';

/** A scrolling element with a drawing larger (or not) than its view, scrolled to 100 / 50. */
function scroller(larger = true) {
  const el = document.createElement('div');
  Object.defineProperties(el, {
    clientWidth: { value: 400 }, clientHeight: { value: 300 },
    scrollWidth: { value: larger ? 1200 : 400 }, scrollHeight: { value: larger ? 900 : 300 },
  });
  el.scrollLeft = 100;
  el.scrollTop = 50;
  el.setPointerCapture = vi.fn();
  return el;
}

function pointer(x: number, y: number, over: Partial<PointerEvent> = {}): PointerEvent {
  return { button: 0, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: y, target: document.createElement('div'), ...over } as PointerEvent;
}

describe('Panner', () => {
  it('scrolls the drawing with the pointer once it has moved far enough', () => {
    const el = scroller();
    const pan = new Panner(el);

    pan.down(pointer(200, 200));
    pan.move(pointer(200 + PAN_THRESHOLD - 1, 200));
    expect(el.scrollLeft).toBe(100);
    expect(el.classList.contains('panning')).toBe(false);

    pan.move(pointer(160, 230));
    expect([el.scrollLeft, el.scrollTop]).toEqual([140, 20]);
    expect(el.classList.contains('panning')).toBe(true);

    pan.up();
    expect(el.classList.contains('panning')).toBe(false);
    pan.move(pointer(0, 0));
    expect([el.scrollLeft, el.scrollTop]).toEqual([140, 20]);
  });

  it('leaves a press on a box or a button to them, and a finger to the browser', () => {
    const el = scroller();
    const pan = new Panner(el);
    const node = el.appendChild(document.createElement('div'));
    node.className = 'node';
    const inner = node.appendChild(document.createElement('span'));

    pan.down(pointer(200, 200, { target: inner }));
    pan.move(pointer(100, 100, { target: inner }));
    pan.up();
    pan.down(pointer(200, 200, { pointerType: 'touch' }));
    pan.move(pointer(100, 100, { pointerType: 'touch' }));
    pan.up();
    pan.down(pointer(200, 200, { button: 2 }));
    pan.move(pointer(100, 100));

    expect([el.scrollLeft, el.scrollTop]).toEqual([100, 50]);
  });

  it('shows that there is something to move to only when the drawing is larger than the view', () => {
    const large = scroller();
    new Panner(large).enter();
    const fitting = scroller(false);
    const pan = new Panner(fitting);
    pan.enter();
    pan.down(pointer(200, 200));
    pan.move(pointer(100, 100));

    expect(large.classList.contains('can-pan')).toBe(true);
    expect(fitting.classList.contains('can-pan')).toBe(false);
    expect(fitting.classList.contains('panning')).toBe(false);
  });

  it('swallows the click that ends a pan, but not a plain click', () => {
    const el = scroller();
    const pan = new Panner(el);
    const clicked = vi.fn();
    const child = el.appendChild(document.createElement('div'));
    child.addEventListener('click', clicked);

    pan.down(pointer(200, 200));
    pan.up();
    child.click();
    expect(clicked).toHaveBeenCalledTimes(1);

    pan.down(pointer(200, 200));
    pan.move(pointer(150, 150));
    pan.up();
    child.click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
