import { ReviewBundle, isFlowView } from './api';
import type { Selection } from './review.store';

/**
 * What a pull request shows when it is opened without a place asked for: its first data flow - the flows are what a
 * review starts with -, the overview when it has none (or the flows are switched off).
 */
export function startSelection(b: ReviewBundle, disabled: ReadonlySet<string> = new Set()): Selection {
  const flows = b.analysis.categories.find((c) => isFlowView(c) && !disabled.has(c.id));
  const first = flows?.groups.find((g) => g.flowId)?.flowId;
  return first ? { kind: 'flow', id: first } : { kind: 'overview' };
}
