import { Acceptance, acceptedIn, statusOf } from './acceptance';

/**
 * How the accept state is shown and clicked in the UI (the rules themselves are in acceptance.ts):
 *
 * - a line has one box per place it is shown at; the box of the place shown stands in front;
 * - at first only the front box can be ticked ("accepted here", green); once it is, a click on the other boxes
 *   accepts the line at all its places ("accepted everywhere", blue) - and a second click takes that step back;
 * - a view without a place (file) has no front box: all boxes act as one and mean "everywhere";
 * - a line with a single place is accepted everywhere as soon as it is accepted.
 */

/** open, accepted at the place shown but not at all places (green), or accepted at all places (blue). */
export type AcceptLevel = 'open' | 'here' | 'all';

/** Level of a set of lines: ok = accepted at the place they are counted at, all = accepted at all their places. */
export function acceptLevel(p: { ok: number; total: number; all: number }): AcceptLevel {
  if (p.total === 0 || p.ok < p.total) {
    return 'open';
  }
  return p.all >= p.total ? 'all' : 'here';
}

export interface PlaceBox {
  id: string;
  on: boolean;
}

export interface LineBoxes {
  /** the box of the place shown (the only box of a line with one place); null in a view without a place */
  front: { on: boolean } | null;
  /** the boxes of the other places */
  rest: PlaceBox[];
  /** the other boxes cannot be clicked yet: the line is not accepted here */
  readonly: boolean;
  /** accepted at all places */
  all: boolean;
  /** ticking the front box accepts the line everywhere: it has one place, or all the others are accepted already */
  completes: boolean;
}

/** The boxes of a line shown at `places`, seen from `place` (null = a view without a place). */
export function lineBoxes(a: Acceptance, places: readonly string[], place: string | null): LineBoxes {
  const all = statusOf(a, places, null) === 'accepted';
  if (places.length < 2) {
    return { front: { on: all }, rest: [], readonly: false, all, completes: true };
  }
  const accepted = new Set(acceptedIn(a, places));
  const here = place != null && places.includes(place) ? place : null;
  const rest = places.filter((p) => p !== here).map((id) => ({ id, on: accepted.has(id) }));
  if (here == null) {
    return { front: null, rest, readonly: false, all, completes: false };
  }
  const on = accepted.has(here);
  return { front: { on }, rest, readonly: !on, all, completes: rest.every((b) => b.on) };
}

/**
 * The places to mark for "ok everywhere" on a line shown at `places`, clicked at `place`; null stands for a mark
 * without a place (all places at once). Accepting (ok) marks all places. Taking it back leaves the place of the click
 * accepted and takes back the others - without such a place, everything.
 */
export function everywhereTargets(places: readonly string[], place: string | null, ok: boolean): (string | null)[] {
  if (ok || place == null || !places.includes(place)) {
    return [null];
  }
  return places.filter((p) => p !== place);
}
