import { describe, expect, it } from 'vitest';
import { PullRequestSummary } from './api';
import { groupByRepo, matchesQuery, relativeTime, rememberRecent, repoKey, togglePinned } from './workspace';

const pr = (repo: string, number: number, updatedAt: string, title = 'Title'): PullRequestSummary => ({
  provider: 'gitlab', owner: 'group~sub', repo, number, title, author: 'ada', url: `https://git.example/${repo}/${number}`,
  draft: false, createdAt: updatedAt, updatedAt, roles: [], progress: null,
});

describe('rememberRecent', () => {
  const now = new Date('2026-11-27T10:00:00Z');

  it('puts the pull request opened last first, each one once', () => {
    let list = rememberRecent([], { ...pr('web', 1, ''), title: 'One' }, now);
    list = rememberRecent(list, { ...pr('web', 2, ''), title: 'Two' }, now);
    list = rememberRecent(list, { ...pr('web', 1, ''), title: 'One, renamed' }, new Date('2026-11-27T11:00:00Z'));

    expect(list.map((r) => r.number)).toEqual([1, 2]);
    expect(list[0]).toMatchObject({ title: 'One, renamed', openedAt: '2026-11-27T11:00:00.000Z' });
  });

  it('keeps only the newest ones', () => {
    let list = rememberRecent([], { ...pr('web', 0, ''), title: 'x' }, now, 3);
    for (let n = 1; n <= 4; n++) {
      list = rememberRecent(list, { ...pr('web', n, ''), title: 'x' }, now, 3);
    }
    expect(list.map((r) => r.number)).toEqual([4, 3, 2]);
  });
});

describe('togglePinned', () => {
  it('pins a repository at the end and takes the pin away again', () => {
    const a = { provider: 'gitlab', owner: 'g', repo: 'a' };
    const b = { provider: 'gitlab', owner: 'g', repo: 'b' };
    const both = togglePinned(togglePinned([], a), b);

    expect(both.map(repoKey)).toEqual(['gitlab/g/a', 'gitlab/g/b']);
    expect(togglePinned(both, { ...a }).map(repoKey)).toEqual(['gitlab/g/b']);
  });
});

describe('groupByRepo', () => {
  it('groups by repository, the one changed last first, and lists each pull request once', () => {
    const groups = groupByRepo([
      pr('api', 1, '2026-11-20T08:00:00Z'), pr('web', 7, '2026-11-25T08:00:00Z'), pr('api', 2, '2026-11-26T08:00:00Z'),
      pr('web', 7, '2026-11-25T08:00:00Z'),
    ]);

    expect(groups.map((g) => g.repo.repo)).toEqual(['api', 'web']);
    expect(groups[0].prs.map((p) => p.number)).toEqual([2, 1]);
    expect(groups[1].prs).toHaveLength(1);
  });
});

describe('matchesQuery', () => {
  const item = pr('web-shop', 42, '', 'Fix the checkout total');

  it('finds every word in repository, title, number or author', () => {
    expect(matchesQuery(item, 'checkout web')).toBe(true);
    expect(matchesQuery(item, 'group/sub/web')).toBe(true);
    expect(matchesQuery(item, '!42')).toBe(true);
    expect(matchesQuery(item, 'ADA fix')).toBe(true);
    expect(matchesQuery(item, '')).toBe(true);
  });

  it('needs all the words', () => {
    expect(matchesQuery(item, 'checkout api')).toBe(false);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-11-27T12:00:00Z');

  it('says how long ago in the largest unit that fits', () => {
    expect(relativeTime('2026-11-27T11:59:40Z', now)).toBe('gerade eben');
    expect(relativeTime('2026-11-27T11:15:00Z', now)).toBe('vor 45 Min.');
    expect(relativeTime('2026-11-27T07:00:00Z', now)).toBe('vor 5 Std.');
    expect(relativeTime('2026-11-26T10:00:00Z', now)).toBe('gestern');
    expect(relativeTime('2026-11-20T10:00:00Z', now)).toBe('vor 7 Tagen');
    expect(relativeTime('2026-09-01T10:00:00Z', now)).toBe('2026-09-01');
  });

  it('is empty without a valid time', () => {
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('gestern', now)).toBe('');
  });
});
