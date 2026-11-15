import { describe, expect, it } from 'vitest';
import { reloadMessage } from './reload-message';

const RELOAD = {
  fromHeadSha: 'aaaaaaa111', toHeadSha: 'bbbbbbb222', at: 'now', kept: 812, dropped: 3,
  newLines: { 'a.ts': ['N1', 'N2'], 'b.ts': ['O4'] },
};

describe('reload message', () => {
  it('says when nothing changed', () => {
    expect(reloadMessage('bbbbbbb222', 'bbbbbbb222', RELOAD)).toBe('Neu geladen: keine neuen Commits');
  });

  it('reports carried and dropped marks and the new lines', () => {
    expect(reloadMessage('aaaaaaa111', 'bbbbbbb222', RELOAD))
      .toBe('Neue Commits: 812 Markierungen übernommen, 3 verworfen (Zeile geändert) · 3 Zeilen neu oder geändert seit aaaaaaa');
  });

  it('falls back when no marks had to be carried', () => {
    expect(reloadMessage('aaaaaaa111', 'bbbbbbb222', null)).toBe('Snapshot neu geladen und analysiert');
  });
});
