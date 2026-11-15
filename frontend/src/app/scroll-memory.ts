import { type PrKey, prLabel } from './api';
import type { Selection } from './review.store';

/** Identifies one view of the editor (a PR plus what is selected in it), e.g. `github/o/r#12 flow:flow-3`. */
export function viewKey(pr: PrKey, sel: Selection): string {
  const what = 'path' in sel ? sel.path : 'id' in sel ? sel.id : '';
  return `${prLabel(pr)} ${sel.kind}:${what}`;
}

/** Scroll position per view, so every view opens where it was left (a view never seen opens at the top). */
export class ScrollMemory {
  private readonly positions = new Map<string, number>();

  constructor(private readonly limit = 200) {}

  save(key: string, top: number): void {
    this.positions.delete(key);
    if (top > 0) {
      this.positions.set(key, top);
      if (this.positions.size > this.limit) {
        this.positions.delete(this.positions.keys().next().value!);
      }
    }
  }

  /** The remembered position of a view, 0 for one never scrolled. */
  positionOf(key: string): number {
    return this.positions.get(key) ?? 0;
  }
}
