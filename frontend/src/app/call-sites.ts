/**
 * Call sites in a line of code: where in the text the calls into other changed code stand, so the jump to the called
 * code can be drawn as a bubble right around the call instead of a chip at the end of the line. Display only - which
 * line calls what comes from the analysis (DisplayLine.refs); here the name is merely looked up in the line.
 */

/** A range of the text of a line (end exclusive) that belongs to the ref with this index. */
export interface CallMark {
  ref: number;
  start: number;
  end: number;
}

const HTTP = /^(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS)\s/;

/**
 * The names a ref can be written as in the calling line, most specific first. «PlayerResource.update» is called as
 * `update`; «saveEvent() → EventResource.save» (a generated client) as `saveEvent`; «PUT /api/players/{} →
 * PlayerResource.update» (a REST call) as `put`. Refs that are no call from this line («aufgerufen von …») have none.
 */
export function callNames(symbol: string): string[] {
  if (/^aufgerufen von /.test(symbol)) {
    return [];
  }
  const names: string[] = [];
  const arrow = symbol.indexOf(' → ');
  const head = arrow < 0 ? symbol : symbol.substring(0, arrow);
  const http = HTTP.exec(head);
  if (http) {
    names.push(http[1].toLowerCase());
  } else {
    names.push(lastName(head));
  }
  if (arrow >= 0) {
    names.push(lastName(symbol.substring(arrow + 3)));
  }
  return names.filter((n, i) => /^[\w$]+$/.test(n) && names.indexOf(n) === i);
}

/** «EventResource.save» -> save, «saveEvent()» -> saveEvent, «Entity Player» -> Player */
function lastName(label: string): string {
  const word = label.trim().split(/\s+/).pop() ?? '';
  return word.replace(/\(\)$/, '').split('.').pop() ?? '';
}

/**
 * Looks up the refs of a line in its text: for each ref the first free place where one of its names is called
 * (`name(`, `name<T>(`), else where the name stands as a word. Refs that are not found get no mark (they stay a chip
 * at the end of the line). The marks do not overlap and come in text order.
 */
export function locateCalls(text: string, symbols: readonly string[]): CallMark[] {
  const marks: CallMark[] = [];
  const free = (start: number, end: number) => marks.every((m) => end <= m.start || start >= m.end);
  symbols.forEach((symbol, ref) => {
    for (const name of callNames(symbol)) {
      const escaped = name.replace(/\$/g, '\\$');
      const found = [`(?<![\\w$])${escaped}(?=\\s*[(<])`, `(?<![\\w$])${escaped}(?![\\w$])`]
        .flatMap((pattern) => [...text.matchAll(new RegExp(pattern, http(symbol) ? 'gi' : 'g'))])
        .find((m) => free(m.index, m.index + name.length));
      if (found) {
        marks.push({ ref, start: found.index, end: found.index + name.length });
        return;
      }
    }
  });
  return marks.sort((a, b) => a.start - b.start);
}

function http(symbol: string): boolean {
  return HTTP.test(symbol);
}

/** What is put around a marked range of highlighted HTML. */
export interface HtmlMark {
  start: number;
  end: number;
  /** opening tag(s) at the start of the range, e.g. the bubble with its number */
  open: string;
  /** opening tag when the range goes on after a tag of the highlighting (the bubble without its number) */
  reopen: string;
  close: string;
}

/**
 * Wraps ranges of the text inside highlighted HTML (tags of the highlighting and entities for & < > " '). Positions
 * count text characters. Where a tag of the highlighting begins or ends inside a range, the wrapper is closed before
 * it and opened again after it, so the result stays well nested.
 */
export function markHtml(html: string, marks: readonly HtmlMark[]): string {
  if (!marks.length) {
    return html;
  }
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  let next = 0;
  let open = false;
  for (const [token] of html.matchAll(/<[^>]*>|&(?:[a-z]+|#x?[0-9a-f]+);|[\s\S]/gi)) {
    const mark = sorted[next];
    if (token.length > 1 && token.startsWith('<')) {
      out += open ? mark.close + token + mark.reopen : token;
      continue;
    }
    if (mark && !open && pos === mark.start) {
      out += mark.open;
      open = true;
    }
    out += token;
    pos++;
    if (mark && open && pos === mark.end) {
      out += mark.close;
      open = false;
      next++;
    }
  }
  return open ? out + sorted[next].close : out;
}

/** Text as the value of an HTML attribute. */
export function attr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
