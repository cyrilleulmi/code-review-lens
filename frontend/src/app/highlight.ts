import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import python from 'highlight.js/lib/languages/python';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { DisplayLine } from './api';

const LANGUAGES = {
  bash, csharp, css, dockerfile, go, java, javascript, json, kotlin, less, markdown, powershell, properties,
  python, scss, sql, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, lang);
}

/** A display line of a block with its hidden lines unfolded: where it sits and in which gap it is hidden. */
export interface FlatLine {
  line: DisplayLine;
  /** index (in the flat list) of the gap this line is hidden in; null for lines shown without expanding */
  gap: number | null;
}

/**
 * The lines of a block with the hidden lines of every gap placed right after the gap (nested gaps too), in file
 * order. The gap itself stays in the list, so callers can show either the gap or its lines.
 */
export function flattenLines(lines: DisplayLine[]): FlatLine[] {
  const result: FlatLine[] = [];
  const add = (list: DisplayLine[], gap: number | null) => {
    for (const line of list) {
      const index = result.length;
      result.push({ line, gap });
      if (line.type === 'gap' && line.hidden?.length) {
        add(line.hidden, index);
      }
    }
  };
  add(lines, null);
  return result;
}

/**
 * Highlights the lines of a code block. The new version (context + added lines) and the old version
 * (context + deleted lines) are highlighted as continuous texts so multi-line constructs (comments,
 * template strings) stay correct; each display line then takes its HTML from the matching version.
 * Pass the flat list (flattenLines) so the hidden lines of gaps are read too: a comment that opens before a gap
 * and closes inside it must not run on. A gap without its lines (unknown text) starts a new text, for the same reason.
 */
export function highlightLines(lines: DisplayLine[], language: string): string[] {
  const lang = hljs.getLanguage(language) ? language : null;
  const result: string[] = lines.map((l) => escape(l.text ?? ''));
  if (!lang) {
    return result;
  }
  let newIdx: number[] = [];
  let oldIdx: number[] = [];
  const flush = () => {
    const newHtml = splitHtml(highlight(newIdx.map((i) => lines[i].text ?? '').join('\n'), lang));
    newIdx.forEach((lineIdx, n) => (result[lineIdx] = newHtml[n] ?? result[lineIdx]));
    const oldHtml = splitHtml(highlight(oldIdx.map((i) => lines[i].text ?? '').join('\n'), lang));
    oldIdx.forEach((lineIdx, n) => {
      if (lines[lineIdx].type === 'del') result[lineIdx] = oldHtml[n] ?? result[lineIdx];
    });
    newIdx = [];
    oldIdx = [];
  };
  lines.forEach((l, i) => {
    if (l.type === 'gap' && !l.hidden?.length) flush();
    if (l.type === 'ctx' || l.type === 'add') newIdx.push(i);
    if (l.type === 'ctx' || l.type === 'del') oldIdx.push(i);
  });
  flush();
  return result;
}

function highlight(code: string, language: string): string {
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escape(code);
  }
}

/** Splits highlighted HTML at newlines, closing and re-opening spans so that every line is valid HTML. */
function splitHtml(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const re = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const token = m[0];
    if (token === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (token.startsWith('<span')) {
      open.push(token);
      current += token;
    } else if (token === '</span>') {
      open.pop();
      current += token;
    } else {
      current += token;
    }
  }
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
