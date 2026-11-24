import { describe, expect, it } from 'vitest';
import { pastedUrl } from './pasted-url';

const MR = 'https://my.git.com/path/to/project/-/merge_requests/747';

describe('pasted url', () => {
  it('takes a plain URL as it is', () => {
    expect(pastedUrl(MR)).toBe(MR);
    expect(pastedUrl('HTTP://my.git.com/a/b')).toBe('HTTP://my.git.com/a/b');
  });

  it('drops what copying from a browser, a mail or a chat brings along', () => {
    expect(pastedUrl(`  ${MR}\n`)).toBe(MR);
    expect(pastedUrl(`​${MR} `)).toBe(MR);
    expect(pastedUrl(`﻿${MR}⁠`)).toBe(MR);
    expect(pastedUrl(`<${MR}>`)).toBe(MR);
  });

  it('is no URL for a search text', () => {
    expect(pastedUrl('merge request 747')).toBeNull();
    expect(pastedUrl('https://')).toBeNull();
    expect(pastedUrl(`see ${MR}`)).toBeNull();
    expect(pastedUrl('')).toBeNull();
  });
});
