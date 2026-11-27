import { Signature, TypeInfo } from './api';

/**
 * How much of a method the diagrams of a data flow show: its name, or its signature (parameters and return type) -
 * the switch «Signatur». Independent of it, the switch «Rückgabewerte» draws what a call gives back as an arrow back
 * (returnType, returnsLabel). The signatures come from the analysis (Segment.signature); here they are put into the
 * short texts the diagrams have room for. The types they name (Analysis.types) show in full in the tooltips.
 */
export type MethodDetail = 'name' | 'signature';

export const METHOD_DETAILS: readonly MethodDetail[] = ['name', 'signature'];

/** Longest signature a diagram shows in one line, and the longest line of a type in a tooltip. */
export const SIGNATURE_MAX = 72;
/** Longest text at a connection of the call graph for what its calls give back. */
export const RETURNS_MAX = 36;
const TYPE_LINE_MAX = 400;

/**
 * The text of a method at a level of detail. name: the plain name; callable: it is called (a function or method),
 * so the name level writes `name()`. Without a signature (a constant, an older analysis) every level shows the name.
 * max: the longest signature, in characters (a diagram with less room passes its own).
 */
export function methodLabel(
  name: string,
  callable: boolean,
  signature: Signature | null | undefined,
  detail: MethodDetail,
  max = SIGNATURE_MAX,
): string {
  if (detail === 'name' || !signature) {
    return callable ? name + '()' : name;
  }
  return signatureLabel(name, signature, max);
}

/** Return types that give nothing back: no arrow back is drawn for them. A wrapper around one (`Promise<void>`) counts too. */
const NOTHING = /^(void|Void|Unit|None|undefined|never|nil)$/;

/**
 * What a call gives back, for the arrow back in the sequence: the return type as declared (`Observable<PlayerDetail>`);
 * null when the signature has none, it is void-like, or it is not known. Longer than `max`: cut with «…».
 */
export function returnType(signature: Signature | null | undefined, max = SIGNATURE_MAX): string | null {
  const type = signature?.returns?.trim();
  if (!type) {
    return null;
  }
  const inner = /^[\w.]+<\s*([\w.]+)\s*>$/.exec(type)?.[1];
  if (NOTHING.test(type) || (inner != null && NOTHING.test(inner))) {
    return null;
  }
  return type.length > max ? type.substring(0, max - 1) + '…' : type;
}

/**
 * What the calls along one connection give back, in one text: the type - or, when several calls with different types
 * share the connection (two classes), the first type and how many more: `Player, +2`. null: none gives anything back.
 */
export function returnsLabel(types: readonly (string | null)[], max = RETURNS_MAX): string | null {
  const distinct = [...new Set(types.filter((type): type is string => !!type))];
  if (!distinct.length) {
    return null;
  }
  const tail = distinct.length > 1 ? `, +${distinct.length - 1}` : '';
  const room = max - tail.length;
  const first = distinct[0];
  return (first.length > room ? first.substring(0, room - 1) + '…' : first) + tail;
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

/** `Player { id: string, name: string, +2 }`; an enum lists its constants, a type without fields is its name. */
export function typeLine(type: TypeInfo, max = TYPE_LINE_MAX): string {
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
  return [signature.declaration, ...known.map((t) => typeLine(t))].join('\n');
}
