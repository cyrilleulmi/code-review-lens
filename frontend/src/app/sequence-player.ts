import { signal } from '@angular/core';

/** How fast the playback moves on: the factors the user can choose from. */
export const PLAYER_SPEEDS = [0.5, 1, 2] as const;

/**
 * Playback of a sequence of calls (flow-sequence.ts): which call is shown now, and the clock that moves on to the
 * next one. The views read `index` and draw the call - the list, the sequence diagram, the flow diagram and the
 * component diagram all follow the same player.
 *
 * index 0 = before the first call (nothing is running yet), 1..length = that call. Playing stops at the last call;
 * play again starts over.
 */
export class SequencePlayer {
  /** the call shown: 0 = none yet, else its number */
  readonly index = signal(0);
  readonly playing = signal(false);
  readonly speed = signal<number>(1);
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** length: number of calls of the sequence shown (read again at every step); stepMs: time per call at speed 1. */
  constructor(private readonly length: () => number, private readonly stepMs = 1300) {}

  /** Time one call is shown at the current speed, in ms (the animations of the views take a part of it). */
  duration(): number {
    return this.stepMs / this.speed();
  }

  toggle(): void {
    if (this.playing()) {
      this.pause();
    } else {
      this.play();
    }
  }

  /** Starts playing at the next call; at the end (or before the start) it begins with the first call. */
  play(): void {
    if (this.length() === 0) {
      return;
    }
    this.index.set(this.index() >= this.length() ? 1 : this.index() + 1);
    this.playing.set(true);
    this.schedule();
  }

  pause(): void {
    this.clear();
    this.playing.set(false);
  }

  /** One call on, by hand: stops the clock. */
  next(): void {
    this.pause();
    this.index.set(Math.min(this.length(), this.index() + 1));
  }

  /** One call back, by hand; before the first call nothing is shown. */
  prev(): void {
    this.pause();
    this.index.set(Math.max(0, this.index() - 1));
  }

  /** Shows the call with this number (kept inside the sequence) and stops the clock. */
  go(no: number): void {
    this.pause();
    this.index.set(Math.max(0, Math.min(this.length(), Math.round(no))));
  }

  /** Back before the first call. */
  reset(): void {
    this.go(0);
  }

  setSpeed(speed: number): void {
    this.speed.set(speed);
    if (this.playing()) {
      this.schedule();
    }
  }

  /** Stops the clock for good (the view is gone). */
  destroy(): void {
    this.clear();
  }

  private schedule(): void {
    this.clear();
    if (this.index() >= this.length()) {
      this.playing.set(false);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      // the sequence may have got shorter in the meantime (another flow, an area removed)
      this.index.set(Math.min(this.length(), this.index() + 1));
      this.schedule();
    }, this.duration());
  }

  private clear(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Keeps what the playback is at in view: where to scroll a container so that a stretch from `start` to `end` of its content lies in view with `margin`
 * around it, moving as little as possible: the current position when it is in view already. A stretch longer than
 * the view shows its start.
 */
export function scrollToShow(scroll: number, view: number, start: number, end: number, margin = 40): number {
  if (start - margin < scroll || end - start + 2 * margin > view) {
    return Math.max(0, start - margin);
  }
  return end + margin > scroll + view ? end + margin - view : scroll;
}
