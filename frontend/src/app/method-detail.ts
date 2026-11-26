import { Signature, TypeInfo } from './api';

/**
 * How much of a method the diagrams of a data flow show: its name, its signature (parameters and return type), or
 * the signature with the data structures behind it - the fields of the types it takes and returns. The signatures and
 * types come from the analysis (Segment.signature, Analysis.types); here they are put into the short texts the
 * diagrams have room for.
 */
export type MethodDetail = 'name' | 'signature' | 'data';

export const METHOD_DETAILS: readonly MethodDetail[] = ['name', 'signature', 'data'];

/** Longest signature a diagram shows in one line, longest line of a data structure, and how many structures per method. */
export const SIGNATURE_MAX = 72;
export const DATA_LINE_MAX = 76;
export const DATA_LINES_MAX = 3;

/** What a diagram writes for a method: its label and, below it, the lines of the data level. */
export interface MethodText {
  label: string;
  /** one line per data structure; empty below the data level and for a method that names no known type */
  data: string[];
}

/**
 * The texts of a method at a level of detail. name: the plain name; callable: it is called (a function or method),
 * so the name level writes `name()`. Without a signature (a constant, an older analysis) every level shows the name.
 * room: the longest signature and the longest line of data, in characters (a diagram with less room passes its own).
 */
export function methodText(
  name: string,
  callable: boolean,
  signature: Signature | null | undefined,
  detail: MethodDetail,
  types: ReadonlyMap<string, TypeInfo>,
  room: { signature: number; data: number } = { signature: SIGNATURE_MAX, data: DATA_LINE_MAX },
): MethodText {
  if (detail === 'name' || !signature) {
    return { label: callable ? name + '()' : name, data: [] };
  }
  return {
    label: signatureLabel(name, signature, room.signature),
    data: detail === 'data' ? dataLines(signature, types, room.data) : [],
  };
}

/**
 * A signature in one line, the same notation for every language: `update(id: string, change: PlayerUpdate): Player`.
 * A parameter without a type is its name, one without a name its type; no return type, nothing after the parentheses.
 * When it gets longer than `max`, parameters are left out from the end (`…`), then the return type is cut.
 */
export function signatureLabel(name: string, signature: Signature, max = SIGNATURE_MAX): string {
  const params = signature.params.map((p) => (p.name && p.type ? `${p.name}: ${p.type}` : p.name || p.type || ''));
  const returns = signature.returns ? ': ' + signature.returns : '';
  const text = (shown: string[], cut: boolean, ret: string) => `${name}(${[...shown, ...(cut ? ['…'] : [])].join(', ')})${ret}`;
  for (let n = params.length; n >= 0; n--) {
    const label = text(params.slice(0, n), n < params.length, returns);
    if (label.length <= max) {
      return label;
    }
  }
  const head = text([], params.length > 0, '');
  const room = max - head.length - 3;
  return room >= 8 && returns ? `${head}: ${signature.returns!.substring(0, room)}…` : head;
}

/**
 * The data structures of a signature: per type it names and the analysis knows, one line `Player { id: string,
 * name: string, +2 }` - as many fields as fit into `max` characters, the rest counted. At most `lines` types; one
 * more line says how many are left out.
 */
export function dataLines(signature: Signature, types: ReadonlyMap<string, TypeInfo>, max = DATA_LINE_MAX, lines = DATA_LINES_MAX): string[] {
  const known = signature.types.map((id) => types.get(id)).filter((t): t is TypeInfo => !!t);
  const shown = known.slice(0, known.length > lines ? lines - 1 : lines).map((t) => typeLine(t, max));
  return known.length > shown.length ? [...shown, `+${known.length - shown.length} …`] : shown;
}

/** `Player { id: string, name: string, +2 }`; an enum lists its constants, a type without fields is its name. */
export function typeLine(type: TypeInfo, max = DATA_LINE_MAX): string {
  if (type.fields.length === 0) {
    return type.name;
  }
  const fields = type.fields.map((f) => (f.type ? `${f.name}: ${f.type}` : f.name));
  const total = fields.length + type.more;
  for (let n = fields.length; n >= 1; n--) {
    const rest = total - n;
    const line = `${type.name} { ${[...fields.slice(0, n), ...(rest > 0 ? ['+' + rest] : [])].join(', ')} }`;
    if (line.length <= max || n === 1) {
      return line.length <= max ? line : line.substring(0, max - 1) + '…';
    }
  }
  return type.name;
}

/** The full texts for a tooltip: the declaration as written and every known type with all the fields the analysis lists. */
export function methodTooltip(signature: Signature | null | undefined, types: ReadonlyMap<string, TypeInfo>): string {
  if (!signature) {
    return '';
  }
  const known = signature.types.map((id) => types.get(id)).filter((t): t is TypeInfo => !!t);
  return [signature.declaration, ...known.map((t) => typeLine(t, 400))].join('\n');
}
