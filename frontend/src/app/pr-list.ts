import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api, PullRequestSummary, RepositorySummary, errorMessage, hostLabel } from './api';
import { ConnectionPanel } from './connection-panel';
import { Icon } from './icon';
import { pastedUrl } from './pasted-url';
import { t } from './i18n';
import { PrItem } from './pr-item';
import { PrFilter, ReviewStore } from './review.store';
import { RepoGroup, RepoRef, Workspace, groupByRepo, matchesQuery, prKeyOf, repoKey, repoLabel } from './workspace';

const COLLAPSED_KEY = 'scr.collapsedLists';
/** How many of the pull requests opened last the list shows. */
const RECENT_SHOWN = 5;

function loadCollapsed(): ReadonlySet<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** A pinned repository in the list: its open pull requests, as far as the filters let them through. */
interface PinnedGroup extends RepoGroup {
  loading: boolean;
  error: string | null;
  /** open pull requests in the repository, before the filters */
  total: number;
}

/**
 * The "Pull Requests" tool window, in the order one needs it: search (also a URL), what was opened last, the pinned
 * repositories with all their open pull requests, then my pull requests by repository. The connections to the code
 * hosts are settings: they stand folded at the bottom once a host is connected.
 */
@Component({
  selector: 'app-pr-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, ConnectionPanel, PrItem],
  template: `
    @if (!connected()) {
      <app-connection-panel />
    }
    <div class="search">
      <app-icon name="search" [size]="13" />
      <input type="search" [placeholder]="t('Filtern, suchen (Repo, PR) oder URL + Enter')" [value]="query()"
             (input)="onInput($any($event.target).value)" (keydown.enter)="enter()" />
    </div>
    @if (isUrl()) {
      <button type="button" class="open-url" (click)="enter()">
        <app-icon name="arrowRight" [size]="13" /> {{ t('URL öffnen') }}
      </button>
    }
    <div class="filters" role="group" [attr.aria-label]="t('Meine Rolle')">
      @for (f of filters; track f.id) {
        <button type="button" [class.active]="store.prFilter() === f.id" [attr.aria-pressed]="store.prFilter() === f.id" (click)="store.prFilter.set(f.id)"
                [title]="t(f.tip)">
          {{ t(f.label) }} <span class="badge">{{ count(f.id) }}</span>
        </button>
      }
    </div>
    @if (hosts().length > 1) {
      <div class="filters hosts" role="group" [attr.aria-label]="t('Pull Requests von')">
        <button type="button" [class.active]="!store.activeHost()" [attr.aria-pressed]="!store.activeHost()" (click)="store.chooseHost(null)">{{ t('Alle Hosts') }}</button>
        @for (h of hosts(); track h.provider) {
          <button type="button" [class.active]="store.activeHost() === h.provider" [attr.aria-pressed]="store.activeHost() === h.provider"
                  (click)="store.chooseHost(h.provider)" [title]="h.url">
            <app-icon [name]="h.kind" [size]="12" /> {{ host(h.url) }}
          </button>
        }
      </div>
    }

    @if (repo(); as r) {
      <div class="repo-head">
        <button type="button" class="back" (click)="closeRepo()">
          <app-icon name="arrowLeft" [size]="13" /> {{ t('Zurück') }}
        </button>
        <span class="repo-name" [title]="label(r)">{{ label(r) }}</span>
        <span class="spacer"></span>
        <button type="button" class="mini" (click)="openWhole(r)" [title]="t('Ganzes Repository analysieren')" [attr.aria-label]="t('Ganzes Repository analysieren')">
          <app-icon name="folder" [size]="13" />
        </button>
        <button type="button" class="mini pin" [class.on]="ws.isPinned(r)" [attr.aria-pressed]="ws.isPinned(r)" (click)="ws.togglePin(r)" [title]="pinTitle(r)" [attr.aria-label]="pinTitle(r)">
          <app-icon name="pin" [size]="13" />
        </button>
      </div>
      <div class="list">
        @if (repoLoading()) {
          <p class="empty">{{ t('Lade Repository …') }}</p>
        }
        @if (repoError(); as e) {
          <p class="empty err">{{ e }}</p>
        }
        @for (pr of repoPrs(); track pr.url) {
          <app-pr-item [pr]="pr" [showRepo]="false" />
        } @empty {
          @if (!repoLoading() && !repoError()) {
            <p class="empty">{{ t('Keine offenen Pull/Merge Requests in diesem Repository.') }}</p>
          }
        }
        @if (!ws.isPinned(r)) {
          <p class="tip"><app-icon name="pin" [size]="12" /> {{ t('Angepinnt stehen die Pull/Merge Requests dieses Repositorys immer in der Liste.') }}</p>
        }
      </div>
    } @else {
      <div class="list">
        @if (recent().length) {
          <button type="button" class="group-head" (click)="toggle('recent')" [attr.aria-expanded]="!collapsed().has('recent')">
            <app-icon [name]="collapsed().has('recent') ? 'chevronRight' : 'chevronDown'" [size]="12" />
            <span class="name">{{ t('Zuletzt geöffnet') }}</span>
            <span class="badge">{{ recent().length }}</span>
          </button>
          @if (!collapsed().has('recent')) {
            @for (pr of recent(); track key(pr)) {
              <app-pr-item [pr]="pr" />
            }
          }
        }

        @for (g of pinned(); track g.key) {
          <div class="group-row">
            <button type="button" class="group-head" (click)="toggle(g.key)" [attr.aria-expanded]="!collapsed().has(g.key)" [title]="label(g.repo)">
              <app-icon [name]="collapsed().has(g.key) ? 'chevronRight' : 'chevronDown'" [size]="12" />
              <app-icon [name]="g.repo.provider" [size]="12" />
              <span class="name">{{ label(g.repo) }}</span>
              <span class="badge" [title]="t('{n} offene Pull/Merge Requests im Repository', { n: g.total })">{{ g.prs.length === g.total ? g.total : g.prs.length + '/' + g.total }}</span>
            </button>
            <button type="button" class="mini" (click)="openWhole(g.repo)" [title]="t('Ganzes Repository analysieren')" [attr.aria-label]="t('Ganzes Repository analysieren')">
              <app-icon name="folder" [size]="13" />
            </button>
            <button type="button" class="mini pin on" aria-pressed="true" (click)="ws.togglePin(g.repo)" [title]="pinTitle(g.repo)" [attr.aria-label]="pinTitle(g.repo)">
              <app-icon name="pin" [size]="13" />
            </button>
          </div>
          @if (!collapsed().has(g.key)) {
            @if (g.error) {
              <p class="empty err">{{ g.error }}</p>
            } @else if (g.loading && !g.total) {
              <p class="empty">{{ t('Lade Repository …') }}</p>
            }
            @for (pr of g.prs; track pr.url) {
              <app-pr-item [pr]="pr" [showRepo]="false" />
            } @empty {
              @if (!g.loading && !g.error) {
                <p class="empty">{{ g.total ? t('Keiner passt zu den Filtern.') : t('Keine offenen Pull/Merge Requests in diesem Repository.') }}</p>
              }
            }
          }
        }

        @if (store.prsLoading() && store.prs().length === 0) {
          <p class="empty">{{ t('Lade Pull Requests …') }}</p>
        }
        @for (g of mine(); track g.key) {
          <div class="group-row">
            <button type="button" class="group-head" (click)="toggle(g.key)" [attr.aria-expanded]="!collapsed().has(g.key)" [title]="label(g.repo)">
              <app-icon [name]="collapsed().has(g.key) ? 'chevronRight' : 'chevronDown'" [size]="12" />
              <app-icon [name]="g.repo.provider" [size]="12" />
              <span class="name">{{ label(g.repo) }}</span>
              <span class="badge">{{ g.prs.length }}</span>
            </button>
            <button type="button" class="mini" (click)="showRepo(g.repo)" [title]="t('Alle offenen Pull/Merge Requests dieses Repositorys zeigen')"
                    [attr.aria-label]="t('Alle offenen Pull/Merge Requests dieses Repositorys zeigen')">
              <app-icon name="layers" [size]="13" />
            </button>
            <button type="button" class="mini pin" aria-pressed="false" (click)="ws.togglePin(g.repo)" [title]="pinTitle(g.repo)" [attr.aria-label]="pinTitle(g.repo)">
              <app-icon name="pin" [size]="13" />
            </button>
          </div>
          @if (!collapsed().has(g.key)) {
            @for (pr of g.prs; track pr.url) {
              <app-pr-item [pr]="pr" [showRepo]="false" />
            }
          }
        }
        @if (!store.prsLoading() && !remoteActive() && !mine().length && !pinned().length && !recent().length) {
          <p class="empty">{{ query().trim() ? t('Keine Treffer.') : t('Keine offenen Pull/Merge Requests. Ohne Token lassen sich öffentliche per URL öffnen.') }}</p>
        }

        @if (!query().trim() && suggested().length) {
          <h4 class="section" [title]="t('Angepinnt stehen die Pull/Merge Requests dieses Repositorys immer in der Liste.')">{{ t('Repositories zum Anpinnen') }}</h4>
          @for (r of suggested(); track key(r)) {
            <div class="group-row">
              <button type="button" class="group-head plain" (click)="showRepo(r)" [title]="t('Alle offenen Pull/Merge Requests dieses Repositorys zeigen')">
                <app-icon [name]="r.provider" [size]="12" />
                <span class="name">{{ label(r) }}</span>
              </button>
              <button type="button" class="mini pin" aria-pressed="false" (click)="ws.togglePin(r)" [title]="pinTitle(r)" [attr.aria-label]="pinTitle(r)">
                <app-icon name="pin" [size]="13" />
              </button>
            </div>
          }
        }

        @if (remoteActive()) {
          @if (remoteLoading()) {
            <p class="empty">{{ t('Suche …') }}</p>
          }
          @if (remoteError(); as e) {
            <p class="empty err">{{ e }}</p>
          }
          @if (remoteRepos().length) {
            <h4 class="section">{{ t('Repositories') }}</h4>
            @for (r of remoteRepos(); track r.provider + r.owner + r.repo) {
              <div class="group-row">
                <button type="button" class="group-head plain two" (click)="showRepo(r)">
                  <app-icon [name]="r.provider" [size]="12" />
                  <span class="name">{{ label(r) }}
                    @if (r.description) {
                      <span class="desc">{{ r.description }}</span>
                    }
                  </span>
                </button>
                <button type="button" class="mini pin" [class.on]="ws.isPinned(r)" [attr.aria-pressed]="ws.isPinned(r)" (click)="ws.togglePin(r)" [title]="pinTitle(r)" [attr.aria-label]="pinTitle(r)">
                  <app-icon name="pin" [size]="13" />
                </button>
              </div>
            }
          }
          @if (remotePrs().length) {
            <h4 class="section">{{ t('Weitere Pull Requests') }}</h4>
            @for (pr of remotePrs(); track pr.url) {
              <app-pr-item [pr]="pr" />
            }
          }
          @if (!remoteLoading() && !remoteError() && !remoteRepos().length && !remotePrs().length && !mine().length && !pinned().length && !recent().length) {
            <p class="empty">{{ t('Keine Treffer.') }}</p>
          }
        }
      </div>
    }

    @if (connected()) {
      <div class="connections" [class.open]="connectionsShown()">
        <button type="button" class="group-head" (click)="toggleConnections()" [attr.aria-expanded]="connectionsShown()"
                [title]="t('Verbindungen zu GitHub und GitLab einstellen')">
          <app-icon [name]="connectionsShown() ? 'chevronDown' : 'chevronRight'" [size]="12" />
          <app-icon name="gear" [size]="12" />
          <span class="name">{{ t('Verbindungen') }}</span>
          <span class="summary">{{ hostSummary() }}</span>
        </button>
        @if (connectionsShown()) {
          <div class="connections-body">
            <app-connection-panel />
          </div>
        }
      </div>
    }
  `,
  styleUrl: './pr-list.scss',
})
export class PrList {
  protected readonly store = inject(ReviewStore);
  protected readonly ws = inject(Workspace);
  private readonly api = inject(Api);
  protected readonly t = t;
  protected readonly label = repoLabel;
  protected readonly host = hostLabel;
  protected readonly query = signal('');
  /** Groups of the list that are folded (their key; 'recent' for what was opened last), kept per browser. */
  protected readonly collapsed = signal<ReadonlySet<string>>(loadCollapsed());
  /** The connections were unfolded here (the toolbar and the status bar unfold them too: store.connectionsOpen). */
  private readonly connectionsUnfolded = signal(false);
  protected readonly connectionsShown = computed(() => this.connectionsUnfolded() || this.store.connectionsOpen());

  protected readonly repo = signal<RepoRef | null>(null);
  protected readonly repoPrs = signal<PullRequestSummary[]>([]);
  protected readonly repoLoading = signal(false);
  protected readonly repoError = signal<string | null>(null);

  private readonly remoteReposAll = signal<RepositorySummary[]>([]);
  /** Repositories found by the search, of the chosen connection only. */
  protected readonly remoteRepos = computed(() => this.onHost(this.remoteReposAll()));
  private readonly remotePrsAll = signal<PullRequestSummary[]>([]);
  protected readonly remoteLoading = signal(false);
  protected readonly remoteError = signal<string | null>(null);

  private debounce: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;
  private repoSeq = 0;

  protected readonly filters: { id: PrFilter; label: string; tip: string }[] = [
    { id: 'all', label: 'Alle', tip: 'Alle offenen Pull/Merge Requests, an denen ich beteiligt bin, und die der angepinnten Repositories' },
    { id: 'authored', label: 'Von mir', tip: 'Die ich geöffnet habe' },
    { id: 'review-requested', label: 'Review', tip: 'Bei denen mein Review angefragt ist' },
    { id: 'involved', label: 'Beteiligt', tip: 'In denen ich erwähnt, zugewiesen oder sonst beteiligt bin' },
  ];

  /** Connections with a signed-in user: with more than one, the list can be narrowed to one of them. */
  protected readonly hosts = computed(() => (this.store.connections() ?? []).filter((c) => !!c.account.user));
  protected readonly connected = computed(() => this.hosts().length > 0);
  protected readonly hostSummary = computed(() => this.hosts().map((c) => hostLabel(c.url)).join(', '));

  /** The query as a PR/MR URL, also when pasted with invisible characters or <…> around it; null for a search. */
  private readonly url = computed(() => pastedUrl(this.query()));
  protected readonly isUrl = computed(() => this.url() != null);
  /** What the query filters by; nothing while it is a URL. */
  private readonly words = computed(() => (this.isUrl() ? '' : this.query().trim()));

  /** True when the query is long enough for a remote search (and is not a URL). */
  protected readonly remoteActive = computed(() => !this.isUrl() && this.query().trim().length >= 2);

  /** The pull requests opened last, as far as they match the query (role filters do not apply: they were opened on purpose). */
  protected readonly recent = computed(() =>
    this.isUrl() ? [] : this.onHost(this.ws.recent()).filter((p) => matchesQuery(p, this.words())).slice(0, RECENT_SHOWN));

  /** Passes the filters: my part in it (as the list of my pull requests knows it) and the query. */
  private passes(pr: PullRequestSummary, roles: ReadonlyMap<string, PullRequestSummary>): boolean {
    const f = this.store.prFilter();
    const mine = pr.roles.length ? pr.roles : roles.get(prKeyOf(pr))?.roles ?? [];
    return (f === 'all' || mine.includes(f)) && matchesQuery(pr, this.words());
  }

  /** The pinned repositories with all their open pull requests. */
  protected readonly pinned = computed<PinnedGroup[]>(() => {
    if (this.isUrl()) {
      return [];
    }
    const mine = new Map(this.store.prs().map((p) => [prKeyOf(p), p]));
    const loaded = this.ws.pinnedPrs();
    return this.onHost(this.ws.pinned()).map((repo) => {
      const key = repoKey(repo);
      const state = loaded.get(key);
      // until the repository has answered: what my own list knows of it
      const all = state?.prs.length || !state?.loading ? state?.prs ?? [] : this.store.prs().filter((p) => repoKey(p) === key);
      const prs = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter((p) => this.passes(p, mine));
      return { key, repo, prs, total: all.length, loading: state?.loading ?? true, error: state?.error ?? null };
    }).filter((g) => !this.words() || g.prs.length > 0);
  });

  /** My pull requests by repository; the pinned repositories stand above, with all their pull requests. */
  protected readonly mine = computed<RepoGroup[]>(() => {
    if (this.isUrl()) {
      return [];
    }
    const pinned = new Set(this.ws.pinned().map(repoKey));
    const none = new Map<string, PullRequestSummary>();
    return groupByRepo(this.store.hostPrs().filter((p) => !pinned.has(repoKey(p)) && this.passes(p, none)));
  });

  /** Repositories one was in and has not pinned. */
  protected readonly suggested = computed(() => {
    const shown = new Set(this.mine().map((g) => g.key));
    return this.onHost(this.ws.suggested()).filter((r) => !shown.has(repoKey(r)));
  });

  /** Search hits that are not already in the lists. */
  protected readonly remotePrs = computed(() => {
    const known = new Set([...this.store.prs(), ...this.pinned().flatMap((g) => g.prs)].map((p) => p.url));
    return this.onHost(this.remotePrsAll()).filter((p) => !known.has(p.url));
  });

  constructor() {
    // a search handed over by the quick switch
    effect(() => {
      const request = this.store.searchRequest();
      if (request) {
        untracked(() => {
          this.closeRepo();
          this.onInput(request.query);
        });
      }
    });
  }

  protected key(x: RepoRef & { number?: number }): string {
    return x.number == null ? repoKey(x) : prKeyOf(x as RepoRef & { number: number });
  }

  /** Only what belongs to the chosen connection (everything when all are shown). */
  private onHost<T extends { provider: string }>(list: readonly T[]): T[] {
    const id = this.store.activeHost();
    return id ? list.filter((x) => x.provider === id) : [...list];
  }

  protected pinTitle(r: RepoRef): string {
    return this.ws.isPinned(r)
      ? t('Angepinnt: die Pull/Merge Requests von {repo} stehen immer in der Liste. Klick: lösen', { repo: repoLabel(r) })
      : t('Anpinnen: die Pull/Merge Requests von {repo} immer in der Liste zeigen', { repo: repoLabel(r) });
  }

  protected toggle(key: string): void {
    const next = new Set(this.collapsed());
    if (!next.delete(key)) {
      next.add(key);
    }
    this.collapsed.set(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // storage unavailable: the groups are just open again next time
    }
  }

  protected toggleConnections(): void {
    const open = !this.connectionsShown();
    this.connectionsUnfolded.set(open);
    if (!open) {
      this.store.connectionsOpen.set(false);
    }
  }

  protected onInput(value: string): void {
    this.query.set(value);
    clearTimeout(this.debounce);
    const q = value.trim();
    this.searchSeq++;
    if (q.length < 2 || pastedUrl(value) != null) {
      this.remoteReposAll.set([]);
      this.remotePrsAll.set([]);
      this.remoteLoading.set(false);
      this.remoteError.set(null);
      return;
    }
    this.remoteLoading.set(true);
    this.debounce = setTimeout(() => this.searchRemote(q), 350);
  }

  private searchRemote(q: string): void {
    const seq = this.searchSeq;
    let pending = 2;
    const done = () => {
      if (seq === this.searchSeq && --pending === 0) {
        this.remoteLoading.set(false);
      }
    };
    this.remoteError.set(null);
    this.api.repos(q).subscribe({
      next: (r) => seq === this.searchSeq && this.remoteReposAll.set(r),
      error: (e) => {
        if (seq === this.searchSeq) {
          this.remoteError.set(errorMessage(e));
        }
        done();
      },
      complete: done,
    });
    this.api.searchPrs(q).subscribe({
      next: (r) => seq === this.searchSeq && this.remotePrsAll.set(r),
      error: (e) => {
        if (seq === this.searchSeq) {
          this.remoteError.set(errorMessage(e));
        }
        done();
      },
      complete: done,
    });
  }

  /** All open pull requests of one repository, in place of the lists. */
  protected showRepo(r: RepoRef): void {
    const ref = { provider: r.provider, owner: r.owner, repo: r.repo };
    this.repo.set(ref);
    this.repoPrs.set([]);
    this.repoError.set(null);
    this.repoLoading.set(true);
    const seq = ++this.repoSeq;
    this.api.repoPrs(ref).subscribe({
      next: (list) => {
        if (seq === this.repoSeq) {
          this.repoPrs.set(list);
          this.repoLoading.set(false);
        }
      },
      error: (e) => {
        if (seq === this.repoSeq) {
          this.repoError.set(errorMessage(e));
          this.repoLoading.set(false);
        }
      },
    });
  }

  protected closeRepo(): void {
    this.repoSeq++;
    this.repo.set(null);
  }

  protected openWhole(r: RepoRef): void {
    this.store.open({ provider: r.provider, owner: r.owner, repo: r.repo, number: 0 });
  }

  protected enter(): void {
    const url = this.url();
    if (url) {
      this.store.openUrl(url);
      this.onInput('');
    }
  }

  protected count(f: PrFilter): number {
    return f === 'all' ? this.store.hostPrs().length : this.store.hostPrs().filter((p) => p.roles.includes(f)).length;
  }
}
