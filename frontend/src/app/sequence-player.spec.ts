import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequencePlayer, scrollToShow } from './sequence-player';

describe('SequencePlayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays call after call and stops at the last one', () => {
    const player = new SequencePlayer(() => 3, 1000);

    player.play();
    expect([player.index(), player.playing()]).toEqual([1, true]);
    vi.advanceTimersByTime(1000);
    expect(player.index()).toBe(2);
    vi.advanceTimersByTime(1000);
    expect([player.index(), player.playing()]).toEqual([3, false]);
    vi.advanceTimersByTime(5000);
    expect(player.index()).toBe(3);
  });

  it('starts over when played again at the end', () => {
    const player = new SequencePlayer(() => 2, 1000);
    player.go(2);

    player.play();

    expect([player.index(), player.playing()]).toEqual([1, true]);
  });

  it('pauses, and steps by hand stop the clock', () => {
    const player = new SequencePlayer(() => 5, 1000);
    player.play();

    player.toggle();
    vi.advanceTimersByTime(3000);
    expect([player.index(), player.playing()]).toEqual([1, false]);

    player.play();
    player.next();
    vi.advanceTimersByTime(3000);
    expect([player.index(), player.playing()]).toEqual([3, false]);
    player.prev();
    expect(player.index()).toBe(2);
  });

  it('stays inside the sequence', () => {
    const player = new SequencePlayer(() => 2, 1000);

    player.prev();
    expect(player.index()).toBe(0);
    player.go(7);
    expect(player.index()).toBe(2);
    player.next();
    expect(player.index()).toBe(2);
    player.reset();
    expect(player.index()).toBe(0);
  });

  it('does not play a sequence without calls', () => {
    const player = new SequencePlayer(() => 0, 1000);

    player.play();

    expect([player.index(), player.playing()]).toEqual([0, false]);
  });

  it('moves on faster at a higher speed, also when it is changed while playing', () => {
    const player = new SequencePlayer(() => 4, 1000);
    player.play();

    player.setSpeed(2);
    expect(player.duration()).toBe(500);
    vi.advanceTimersByTime(500);
    expect(player.index()).toBe(2);
    vi.advanceTimersByTime(500);
    expect(player.index()).toBe(3);
  });

  it('follows a sequence that got shorter while playing', () => {
    let length = 5;
    const player = new SequencePlayer(() => length, 1000);
    player.go(2);
    player.play();
    expect([player.index(), player.playing()]).toEqual([3, true]);
    length = 2;

    vi.advanceTimersByTime(1000);

    expect([player.index(), player.playing()]).toEqual([2, false]);
  });

  it('does nothing any more once destroyed', () => {
    const player = new SequencePlayer(() => 3, 1000);
    player.play();

    player.destroy();
    vi.advanceTimersByTime(5000);

    expect(player.index()).toBe(1);
  });
});

describe('scrollToShow', () => {
  it('stays where it is when the stretch is in view', () => {
    expect(scrollToShow(100, 500, 200, 300)).toBe(100);
  });

  it('moves just far enough to show a stretch below or right of the view, with air around it', () => {
    expect(scrollToShow(100, 500, 700, 800)).toBe(340);
    expect(scrollToShow(100, 500, 580, 620, 10)).toBe(130);
  });

  it('moves back to a stretch above or left of the view, never before the start', () => {
    expect(scrollToShow(400, 500, 200, 300)).toBe(160);
    expect(scrollToShow(400, 500, 10, 60)).toBe(0);
  });

  it('shows the start of a stretch that is longer than the view', () => {
    expect(scrollToShow(0, 300, 500, 900)).toBe(460);
  });
});
