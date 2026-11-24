import { describe, expect, it } from 'vitest';
import { formRequest } from './connections';

describe('formRequest', () => {
  const connection = { url: 'https://gitlab.example.com' };

  it('sends only what was changed', () => {
    expect(formRequest(connection, { url: 'https://gitlab.example.com', token: '', cookie: '', saveCookie: false }))
      .toEqual({ url: null, token: null, cookie: null, saveCookie: false });
  });

  it('sends a new URL, token and cookie, trimmed', () => {
    expect(formRequest(connection, { url: ' https://other.example.com ', token: ' glpat-x ', cookie: 'sso=1\n', saveCookie: true }))
      .toEqual({ url: 'https://other.example.com', token: 'glpat-x', cookie: 'sso=1', saveCookie: true });
  });

  it('keeps the URL in use when the field is emptied', () => {
    expect(formRequest(connection, { url: '  ', token: '', cookie: '', saveCookie: false }).url).toBeNull();
  });
});
