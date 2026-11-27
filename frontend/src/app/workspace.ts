import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, PrKey, PullRequestSummary, errorMessage, ownerLabel } from './api';
import { t } from './i18n';

/**
 * What one comes back to between pull requests, kept per browser: the pull requests opened last and the repositories
 * that are pinned - their open pull requests always stand in the list, whoever they are assigned to. The functions
 * are the rules (order, limits, grouping), the service below holds the state and loads the pinned repositories.
 */
export interface RepoRef {
  provider: string;
  owner: string;
  repo: string;
}

/** A pull request opened in this browser (number 0: a whole repository). */
export interface RecentPr extends PrKey {
  title: string;
  /** when it was opened last (ISO) */
  openedAt: string;
}

/** Pull requests of one repository, as a group of the lists. */
export interface RepoGroup {
  key: string;
  repo: RepoRef;
  prs: PullRequestSummary[];
}

export const RECENT_MAX = 12;
const RECENT_KEY = 'scr.recentPrs';
const PINNED_KEY = 'scr.pinnedRepos';
const TABS_KEY = 'scr.openTabs';
/** The list of recently opened repositories of earlier versions: they are offered for pinning. */
const OLD_RECENT_REPOS_KEY = 'scr.recentRepos';

export function repoKey(r: RepoRef): string {
  return `${r.provider}/${r.owner}/${r.repo}`;
}

export function prKeyOf(pr: PrKey): string {
  return `${repoKey(pr)}/${pr.number}`;
}

/** "group/sub/repo": a repository as people write it. */
export function repoLabel(r: RepoRef): string {
  return `${ownerLabel(r.owner)}/${r.repo}`;
}

/** The pull request just opened goes first; one entry per pull request, at most `max`. */
export function rememberRecent(list: readonly RecentPr[], pr: PrKey & { title: string }, now: Date, max = RECENT_MAX): RecentPr[] {
  const entry: RecentPr = { provider: pr.provider, owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, openedAt: now.toISOString() };
  return [entry, ...list.filter((r) => prKeyOf(r) !== prKeyOf(entry))].slice(0, max);
}

/** Pins a repository (at the end: the order they were pinned in), or takes the pin away. */
export function togglePinned(list: readonly RepoRef[], repo: RepoRef): RepoRef[] {
  const key = repoKey(repo);
  return list.some((r) => repoKey(r) === key)
    ? list.filter((r) => repoKey(r) !== key)
    : [...list, { provider: repo.provider, owner: repo.owner, repo: repo.repo }];
}

/**
 * Pull requests by repository: the repository with the pull request changed last goes first, inside a repository
 * the pull request changed last. Each pull request once (by its URL).
 */
export function groupByRepo(prs: readonly PullRequestSummary[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const seen = new Set<string>();
  for (const pr of prs) {
    if (seen.has(pr.url)) {
      continue;
    }
    seen.add(pr.url);
    const key = repoKey(pr);
    const group = groups.get(key) ?? { key, repo: { provider: pr.provider, owner: pr.owner, repo: pr.repo }, prs: [] };
    group.prs.push(pr);
    groups.set(key, group);
  }
  const latest = (g: RepoGroup) => g.prs.reduce((max, p) => (p.updatedAt > max ? p.updatedAt : max), '');
  const list = [...groups.values()];
  list.forEach((g) => g.prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  return list.sort((a, b) => latest(b).localeCompare(latest(a)) || a.key.localeCompare(b.key));
}

/** Every word of the query is in the repository, the title, the number or the author (case does not matter). */
export function matchesQuery(pr: { owner: string; repo: string; number: number; title: string; author?: string }, query: string): boolean {
  const text = `${repoLabel({ provider: '', owner: pr.owner, repo: pr.repo })} ${pr.title} ${pr.number} ${pr.author ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter((w) => w).every((w) => text.includes(w.replace(/^[#!]/, '')));
}

/** "vor 5 Min.", "vor 3 Std.", "gestern", "vor 4 Tagen", then the date: how long ago something happened. */
export function relativeTime(iso: string | null | undefined, now: Date): string {
  const then = iso ? new Date(iso) : null;
  if (!then || Number.isNaN(then.getTime())) {
    return '';
  }
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (minutes < 1) {
    return t('gerade eben');
  }
  if (minutes < 60) {
    return t('vor {n} Min.', { n: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('vor {n} Std.', { n: hours });
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return t('gestern');
  }
  if (days < 30) {
    return t('vor {n} Tagen', { n: days });
  }
  return then.toISOString().substring(0, 10);
}

/**
 * A pull request that is open as a tab at the left edge. Its colour (1..8 of the palette of the connections) marks
 * it wherever it shows: its tab, its entry in the lists, the toolbar.
 */
export interface OpenTab extends PrKey {
  title: string;
  color: number;
}

/** How many colours the tabs have; with more tabs open, colours repeat. */
export const TAB_COLORS = 8;

/** The colour of a tab as a CSS value. */
export function tabColor(color: number): string {
  return `var(--edge-${((Math.max(1, color) - 1) % TAB_COLORS) + 1})`;
}

/**
 * Opens a tab for the pull request at the end of the row, in the first colour no open tab has (with all taken: the
 * one used least). A pull request that has a tab keeps it and its colour, with the title as it is now.
 */
export function addTab(tabs: readonly OpenTab[], pr: PrKey & { title: string }): OpenTab[] {
  const key = prKeyOf(pr);
  if (tabs.some((tab) => prKeyOf(tab) === key)) {
    return tabs.map((tab) => (prKeyOf(tab) === key ? { ...tab, title: pr.title } : tab));
  }
  const used = (color: number) => tabs.filter((tab) => tab.color === color).length;
  const colors = Array.from({ length: TAB_COLORS }, (_, i) => i + 1);
  const color = colors.reduce((best, c) => (used(c) < used(best) ? c : best), 1);
  return [...tabs, { provider: pr.provider, owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, color }];
}

/** Closes a tab. next: the tab to go on with when it was the one shown - the one after it, else the one before. */
export function removeTab(tabs: readonly OpenTab[], pr: PrKey): { tabs: OpenTab[]; next: OpenTab | null } {
  const key = prKeyOf(pr);
  const at = tabs.findIndex((tab) => prKeyOf(tab) === key);
  const rest = tabs.filter((tab) => prKeyOf(tab) !== key);
  return { tabs: rest, next: at < 0 ? null : rest[at] ?? rest[at - 1] ?? null };
}

/**
 * Two letters for a repository, for the square of its tab: the first letters of its first two words
 * ("smart-code-review" → SC, "StvBeroPlatform" → SB), of a name in one word its first two letters ("spongecoach" → SP).
 */
export function repoInitials(repo: string): string {
  const words = repo.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter((w) => w);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? repo).substring(0, 2);
  return letters.toUpperCase();
}

function read<T>(key: string, valid: (x: T) => boolean): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((x) => x && valid(x)) : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: it is just not remembered
  }
}

const isRepo = (r: RepoRef) => !!(r.provider && r.owner && r.repo);

/** What a pinned repository shows: its open pull requests, while they load, or why they could not be loaded. */
export interface PinnedState {
  prs: PullRequestSummary[];
  loading: boolean;
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class Workspace {
  private readonly api = inject(Api);
  readonly recent = signal<RecentPr[]>(read<RecentPr>(RECENT_KEY, (r) => isRepo(r) && typeof r.number === 'number'));
  readonly pinned = signal<RepoRef[]>(read<RepoRef>(PINNED_KEY, isRepo));
  /** Repositories opened in earlier versions and not pinned: offered once more, for pinning. */
  readonly suggested = computed(() => {
    const pinned = new Set(this.pinned().map(repoKey));
    const known = new Map<string, RepoRef>();
    [...this.recent(), ...read<RepoRef>(OLD_RECENT_REPOS_KEY, isRepo)].forEach((r) => known.set(repoKey(r), { provider: r.provider, owner: r.owner, repo: r.repo }));
    return [...known.values()].filter((r) => !pinned.has(repoKey(r))).slice(0, 6);
  });
  /** The pull requests open as tabs, in the order they were opened; they come back with the browser. */
  readonly tabs = signal<OpenTab[]>(read<OpenTab>(TABS_KEY, (tab) => isRepo(tab) && typeof tab.number === 'number' && typeof tab.color === 'number'));

  tabOf(pr: PrKey): OpenTab | null {
    const key = prKeyOf(pr);
    return this.tabs().find((tab) => prKeyOf(tab) === key) ?? null;
  }

  /** A pull request was opened: it gets a tab (or keeps the one it has). */
  openTab(pr: PrKey & { title: string }): void {
    this.setTabs(addTab(this.tabs(), pr));
  }

  /** Closes the tab; returns the tab to show instead when the closed one was shown. */
  closeTab(pr: PrKey): OpenTab | null {
    const { tabs, next } = removeTab(this.tabs(), pr);
    this.setTabs(tabs);
    return next;
  }

  private setTabs(tabs: OpenTab[]): void {
    this.tabs.set(tabs);
    write(TABS_KEY, tabs);
  }

  /** The open pull requests of every pinned repository, by repoKey. */
  readonly pinnedPrs = signal<ReadonlyMap<string, PinnedState>>(new Map());
  private loadedAt = 0;

  isPinned(repo: RepoRef): boolean {
    const key = repoKey(repo);
    return this.pinned().some((r) => repoKey(r) === key);
  }

  togglePin(repo: RepoRef): void {
    const next = togglePinned(this.pinned(), repo);
    this.pinned.set(next);
    write(PINNED_KEY, next);
    if (this.isPinned(repo)) {
      this.load(repo);
    }
  }

  /** A pull request was opened: it leads the list of the ones opened last. */
  noteOpened(pr: PrKey & { title: string }): void {
    const next = rememberRecent(this.recent(), pr, new Date());
    this.recent.set(next);
    write(RECENT_KEY, next);
  }

  forget(pr: PrKey): void {
    const next = this.recent().filter((r) => prKeyOf(r) !== prKeyOf(pr));
    this.recent.set(next);
    write(RECENT_KEY, next);
  }

  /** Loads the pull requests of all pinned repositories; `maxAgeMs`: only when the last load is older than that. */
  refreshPinned(maxAgeMs = 0): void {
    if (Date.now() - this.loadedAt < maxAgeMs) {
      return;
    }
    this.loadedAt = Date.now();
    this.pinned().forEach((r) => this.load(r));
  }

  private load(repo: RepoRef): void {
    const key = repoKey(repo);
    const set = (change: Partial<PinnedState>) => {
      const next = new Map(this.pinnedPrs());
      next.set(key, { prs: [], loading: false, error: null, ...next.get(key), ...change });
      this.pinnedPrs.set(next);
    };
    set({ loading: true, error: null });
    this.api.repoPrs(repo).subscribe({
      next: (prs) => set({ prs, loading: false }),
      error: (e) => set({ loading: false, error: errorMessage(e) }),
    });
  }
}
