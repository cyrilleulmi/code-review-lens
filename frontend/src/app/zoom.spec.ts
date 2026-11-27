import { describe, expect, it } from 'vitest';
import { ZOOM_MAX, ZOOM_MIN, clampZoom, fitZoom, wheelZoom, zoomAround, zoomStep, zoomToShow } from './zoom';

describe('zoomStep', () => {
  it('goes to the next step in and out', () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    // from a zoom between two steps (Ctrl + wheel, fit)
    expect(zoomStep(0.72, 1)).toBe(0.8);
    expect(zoomStep(0.72, -1)).toBe(0.67);
  });

  it('stops at the ends', () => {
    expect(zoomStep(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(zoomStep(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
});

describe('wheelZoom', () => {
  it('zooms in with the wheel up and out with the wheel down, inside the limits', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100)).toBeLessThan(1);
    expect(wheelZoom(ZOOM_MAX, -1000)).toBe(ZOOM_MAX);
    expect(wheelZoom(ZOOM_MIN, 1000)).toBe(ZOOM_MIN);
  });
});

describe('fitZoom', () => {
  it('shows the whole content, at most at the zoom given', () => {
    expect(fitZoom(2000, 500, 1000, 800)).toBe(0.5);
    expect(fitZoom(1000, 1600, 1000, 800)).toBe(0.5);
    expect(fitZoom(400, 300, 1000, 800)).toBe(1);
    expect(fitZoom(400, 300, 1000, 800, 1.5)).toBe(1.5);
  });

  it('never goes below the smallest zoom, and keeps the zoom without a size', () => {
    expect(fitZoom(100000, 100, 1000, 800)).toBe(ZOOM_MIN);
    expect(fitZoom(0, 0, 1000, 800)).toBe(1);
    expect(fitZoom(500, 500, 0, 0, 0.8)).toBe(0.8);
  });
});

describe('zoomToShow', () => {
  const view = { w: 1000, h: 600 };

  it('keeps the zoom chosen when both ends of the call fit into the view', () => {
    expect(zoomToShow({ x1: 100, y1: 50, x2: 700, y2: 300 }, view.w, view.h, 1)).toBe(1);
    expect(zoomToShow({ x1: 100, y1: 50, x2: 500, y2: 300 }, view.w, view.h, 1.5)).toBe(1.5);
  });

  it('zooms out as far as the call needs, with a margin around it', () => {
    const zoom = zoomToShow({ x1: 0, y1: 0, x2: 1904, y2: 200 }, view.w, view.h, 1);
    expect(zoom).toBe(0.5);
    expect((1904 + 96) * zoom).toBeLessThanOrEqual(view.w);
    // a call far down: the height decides
    expect(zoomToShow({ x1: 0, y1: 0, x2: 300, y2: 1104 }, view.w, view.h, 1)).toBe(0.5);
  });

  it('never zooms further in than the zoom chosen', () => {
    expect(zoomToShow({ x1: 0, y1: 0, x2: 100, y2: 40 }, view.w, view.h, 0.5)).toBe(0.5);
  });
});

describe('zoomAround', () => {
  it('keeps the point under the pointer in place', () => {
    // the point 300 px into the view of a drawing scrolled by 200 at zoom 1 is at 500; at zoom 2 it is at 1000
    expect(zoomAround(200, 300, 1, 2)).toBe(700);
    expect(zoomAround(700, 300, 2, 1)).toBe(200);
    expect(zoomAround(0, 100, 1, 0.5)).toBe(0);
  });
});

describe('clampZoom', () => {
  it('rounds to percent and stays inside the limits', () => {
    expect(clampZoom(0.777)).toBe(0.78);
    expect(clampZoom(5)).toBe(ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
  });
});
