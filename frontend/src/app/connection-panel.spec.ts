import { describe, expect, it } from 'vitest';
import { hostLabel, providerInfo, providerKind } from './api';
import { sameHost } from './connection-panel';

describe('connections', () => {
  it('knows the kind of an added connection by its id', () => {
    expect(providerKind('gitlab~git.example.com_8443')).toBe('gitlab');
    expect(providerKind('github')).toBe('github');
    expect(providerInfo('gitlab~git.example.com').sigil).toBe('!');
    expect(providerInfo('github~ghe.example.com').noun).toBe('Pull Request');
  });

  it('compares hosts the way the backend does', () => {
    expect(sameHost('https://gitlab.com', 'HTTPS://GitLab.com:443/')).toBe(true);
    expect(sameHost('http://git.example.com', 'https://git.example.com')).toBe(true);
    expect(sameHost('https://git.example.com:8443', 'https://git.example.com')).toBe(false);
    expect(sameHost('https://git.example.com', 'not a url')).toBe(false);
  });

  it('shows a host as people know it', () => {
    expect(hostLabel('https://git.example.com:8443')).toBe('git.example.com:8443');
    expect(hostLabel('https://gitlab.com')).toBe('gitlab.com');
  });
});
