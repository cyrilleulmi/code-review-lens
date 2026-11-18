import { describe, expect, it } from 'vitest';
import { attr, callNames, locateCalls, markHtml } from './call-sites';

describe('callNames', () => {
  it('takes the method of a called symbol', () => {
    expect(callNames('CurrentUserService.isSelf')).toEqual(['isSelf']);
    expect(callNames('byJerseyNumber')).toEqual(['byJerseyNumber']);
  });

  it('takes the HTTP verb of a REST call, then the endpoint method', () => {
    expect(callNames('PUT /api/players/{} → PlayerResource.update')).toEqual(['put', 'update']);
  });

  it('takes the client function of a generated client', () => {
    expect(callNames('saveEvent() → EventResource.save')).toEqual(['saveEvent', 'save']);
  });

  it('has no name for a ref that is no call from the line', () => {
    expect(callNames('aufgerufen von PlayerResource.update')).toEqual([]);
  });
});

describe('locateCalls', () => {
  it('finds the call of each ref', () => {
    const text = '    return this.isCoach() || this.isSelf(playerId);';
    const marks = locateCalls(text, ['CurrentUserService.isSelf', 'CurrentUserService.isCoach']);

    expect(marks.map((m) => [m.ref, text.substring(m.start, m.end)])).toEqual([[1, 'isCoach'], [0, 'isSelf']]);
  });

  it('prefers the call over an earlier mention of the name', () => {
    const text = 'const update = this.update(update);';
    const [mark] = locateCalls(text, ['Service.update']);

    expect(text.substring(mark.start - 5, mark.end + 1)).toBe('this.update(');
  });

  it('gives two refs with the same name one call each and leaves a ref out that is not written in the line', () => {
    const text = 'validate(a); validate(b);';
    const marks = locateCalls(text, ['A.validate', 'B.validate', 'C.missing']);

    expect(marks).toEqual([{ ref: 0, start: 0, end: 8 }, { ref: 1, start: 13, end: 21 }]);
  });

  it('finds a REST call by its verb, whatever the case, and a generic call', () => {
    const text = 'return this.http.put<PlayerDetail>(`/api/players/${id}`, body);';
    const [mark] = locateCalls(text, ['PUT /api/players/{} → PlayerResource.update']);

    expect(text.substring(mark.start, mark.end)).toBe('put');
  });

  it('does not match inside a longer name', () => {
    expect(locateCalls('this.isSelfish(x)', ['Service.isSelf'])).toEqual([]);
  });
});

describe('markHtml', () => {
  const mark = (start: number, end: number) => ({ start, end, open: '[', reopen: '[+', close: ']' });

  it('wraps a range of plain text', () => {
    expect(markHtml('a.call(b)', [mark(2, 6)])).toBe('a.[call](b)');
  });

  it('counts an entity as one character', () => {
    expect(markHtml('a &amp;&amp; call()', [mark(5, 9)])).toBe('a &amp;&amp; [call]()');
  });

  it('opens inside the tag that starts at the range and closes before the tag that ends it', () => {
    expect(markHtml('x.<span class="t">call</span>()', [mark(2, 6)])).toBe('x.<span class="t">[call]</span>()');
  });

  it('closes and opens again around a tag inside the range', () => {
    expect(markHtml('<span>ca</span>ll()', [mark(0, 4)])).toBe('<span>[ca]</span>[+ll]()');
  });

  it('wraps several ranges', () => {
    expect(markHtml('a(); b();', [mark(5, 6), mark(0, 1)])).toBe('[a](); [b]();');
  });
});

describe('attr', () => {
  it('escapes a text for an attribute', () => {
    expect(attr('a "b" <c> & d')).toBe('a &quot;b&quot; &lt;c&gt; &amp; d');
  });
});
