import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Api, PullRequestSummary, RepositorySummary, errorMessage, ownerLabel, providerInfo } from './api';
import { Icon } from './icon';
import { t } from './i18n';
import { PrFilter, ReviewStore } from './review.store';

type RepoRef = { provider: string; owner: string; repo: string };

const RECENT_KEY = 'scr.recentRepos';
const RECENT_MAX = 8;

function loadRecent(): RepoRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => r && r.provider && r.owner && r.repo).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** The "Pull Requests" tool window: my open PRs, plus search over repositories and PRs I'm not assigned to. */
@Component({
  selector: 'app-pr-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NgTemplateOutlet],
  template: `
    <div class="filters">
      @for (f of filters; track f.id) {
        <button type="button" [class.active]="store.prFilter() === f.id" (click)="store.prFilter.set(f.id)">
          {{ t(f.label) }} <span class="badge">{{ count(f.id) }}</span>
        </button>
      }
    </div>
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
    @if (repo(); as r) {
      <div class="repo-head">
        <button type="button" class="back" (click)="closeRepo()">
          <app-icon name="arrowLeft" [size]="13" /> {{ t('Zurück') }}
        </button>
        <span class="repo-name" [title]="owner(r) + '/' + r.repo">{{ owner(r) }}/{{ r.repo }}</span>
      </div>
      <div class="list">
        <button type="button" class="item whole" (click)="openWhole(r)">
          <span class="line1">
            <app-icon name="arrowRight" [size]="14" />
            <span class="title">{{ t('Ganzes Repository analysieren') }}</span>
          </span>
        </button>
        @if (repoLoading()) {
          <p class="empty">{{ t('Lade Repository …') }}</p>
        }
        @if (repoError(); as e) {
          <p class="empty err">{{ e }}</p>
        }
        @for (pr of repoPrs(); track pr.url) {
          <ng-container [ngTemplateOutlet]="prItem" [ngTemplateOutletContext]="{ $implicit: pr }" />
        } @empty {
          @if (!repoLoading() && !repoError()) {
            <p class="empty">{{ t('Keine offenen Pull/Merge Requests in diesem Repository.') }}</p>
          }
        }
      </div>
    } @else {
      <div class="list">
        @if (store.prsLoading() && store.prs().length === 0) {
          <p class="empty">{{ t('Lade Pull Requests …') }}</p>
        }
        @for (pr of visible(); track pr.url) {
          <ng-container [ngTemplateOutlet]="prItem" [ngTemplateOutletContext]="{ $implicit: pr }" />
        } @empty {
          @if (!store.prsLoading() && !remoteActive()) {
            <p class="empty">{{ t('Keine offenen Pull/Merge Requests. Ohne Token lassen sich öffentliche per URL öffnen.') }}</p>
          }
        }

        @if (!query().trim() && recent().length) {
          <h4 class="section">{{ t('Zuletzt geöffnete Repositories') }}</h4>
          @for (r of recent(); track r.provider + r.owner + r.repo) {
            <button type="button" class="item repo-item" (click)="showRepo(r)">
              <span class="line1">
                <app-icon [name]="r.provider" [size]="14" />
                <span class="title">{{ owner(r) }}/{{ r.repo }}</span>
              </span>
            </button>
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
              <button type="button" class="item repo-item" (click)="showRepo(r)">
                <span class="line1">
                  <app-icon [name]="r.provider" [size]="14" />
                  <span class="title">{{ owner(r) }}/{{ r.repo }}</span>
                </span>
                @if (r.description) {
                  <span class="line2 desc">{{ r.description }}</span>
                }
              </button>
            }
          }
          @if (remotePrs().length) {
            <h4 class="section">{{ t('Weitere Pull Requests') }}</h4>
            @for (pr of remotePrs(); track pr.url) {
              <ng-container [ngTemplateOutlet]="prItem" [ngTemplateOutletContext]="{ $implicit: pr }" />
            }
          }
          @if (!remoteLoading() && !remoteError() && !remoteRepos().length && !remotePrs().length && !visible().length) {
            <p class="empty">{{ t('Keine Treffer.') }}</p>
          }
        }
      </div>
    }

    <ng-template #prItem let-pr>
      <button type="button" class="item" [class.selected]="isCurrent(pr)" (click)="open(pr)">
        <span class="line1">
          <app-icon [name]="pr.provider" [size]="14" [class]="pr.draft ? 'draft' : 'open'" [title]="info(pr).label" />
          <span class="title">{{ pr.title }}</span>
        </span>
        <span class="line2">
          <span class="repo" [title]="owner(pr) + '/' + pr.repo">{{ pr.repo }}</span>
          {{ pr.number === 0 ? t('ganzes Repository') : info(pr).sigil + pr.number }} · {{ pr.author }}
          @for (r of pr.roles; track r) {
            <span class="role" [class]="'role r-' + r">{{ roleLabel(r) }}</span>
          }
          @if (pr.progress; as p) {
            <span class="prog" [title]="t('{ok}/{total} Zeilen ok', { ok: p.ok, total: p.total })">
              <span class="bar"><span [style.width.%]="p.total ? (p.ok / p.total) * 100 : 0"></span></span>
            </span>
          }
        </span>
      </button>
    </ng-template>
  `,
  styleUrl: './pr-list.scss',
})
export class PrList {
  protected readonly store = inject(ReviewStore);
  private readonly api = inject(Api);
  protected readonly t = t;
  protected readonly query = signal('');

  protected readonly repo = signal<RepoRef | null>(null);
  protected readonly repoPrs = signal<PullRequestSummary[]>([]);
  protected readonly repoLoading = signal(false);
  protected readonly repoError = signal<string | null>(null);

  protected readonly remoteRepos = signal<RepositorySummary[]>([]);
  private readonly remotePrsAll = signal<PullRequestSummary[]>([]);
  protected readonly remoteLoading = signal(false);
  protected readonly remoteError = signal<string | null>(null);
  protected readonly recent = signal<RepoRef[]>(loadRecent());

  private debounce: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;
  private repoSeq = 0;

  protected readonly filters: { id: PrFilter; label: string }[] = [
    { id: 'all', label: 'Alle' },
    { id: 'authored', label: 'Von mir' },
    { id: 'review-requested', label: 'Review' },
    { id: 'involved', label: 'Beteiligt' },
  ];

  protected readonly isUrl = computed(() => /^https?:\/\//.test(this.query().trim()));

  /** True when the query is long enough for a remote search (and is not a URL). */
  protected readonly remoteActive = computed(() => !this.isUrl() && this.query().trim().length >= 2);

  /** Search hits that are not already in the local list. */
  protected readonly remotePrs = computed(() => {
    const known = new Set(this.store.prs().map((p) => p.url));
    return this.remotePrsAll().filter((p) => !known.has(p.url));
  });

  protected readonly visible = computed(() => {
    if (this.isUrl()) {
      return [];
    }
    const q = this.query().toLowerCase().trim();
    return this.store.filteredPrs().filter((p) => !q || `${ownerLabel(p.owner)}/${p.repo} ${p.title} ${p.number} ${p.provider}`.toLowerCase().includes(q));
  });

  protected onInput(value: string): void {
    this.query.set(value);
    clearTimeout(this.debounce);
    const q = value.trim();
    this.searchSeq++;
    if (q.length < 2 || /^https?:\/\//.test(q)) {
      this.remoteRepos.set([]);
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
      next: (r) => seq === this.searchSeq && this.remoteRepos.set(r),
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

  protected showRepo(r: RepoRef): void {
    const ref = { provider: r.provider, owner: r.owner, repo: r.repo };
    this.rememberRepo(ref);
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
    this.rememberRepo(r);
    this.store.open({ provider: r.provider, owner: r.owner, repo: r.repo, number: 0 });
  }

  private rememberRepo(r: RepoRef): void {
    const ref = { provider: r.provider, owner: r.owner, repo: r.repo };
    const same = (x: RepoRef) => x.provider === ref.provider && x.owner === ref.owner && x.repo === ref.repo;
    const next = [ref, ...this.recent().filter((x) => !same(x))].slice(0, RECENT_MAX);
    this.recent.set(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: the recent list just stays in memory
    }
  }

  protected roleLabel(role: string): string {
    return role === 'authored' ? t('von mir') : role === 'involved' ? t('beteiligt') : t('Review');
  }

  protected info(pr: PullRequestSummary) {
    return providerInfo(pr.provider);
  }

  protected owner(pr: RepoRef): string {
    return ownerLabel(pr.owner);
  }

  protected enter(): void {
    if (this.isUrl()) {
      this.store.openUrl(this.query());
      this.onInput('');
    }
  }

  protected count(f: PrFilter): number {
    return f === 'all' ? this.store.prs().length : this.store.prs().filter((p) => p.roles.includes(f)).length;
  }

  protected isCurrent(pr: PullRequestSummary): boolean {
    const k = this.store.prKey();
    return !!k && k.owner === pr.owner && k.repo === pr.repo && k.number === pr.number;
  }

  protected open(pr: PullRequestSummary): void {
    this.rememberRepo(pr);
    this.store.open({ provider: pr.provider, owner: pr.owner, repo: pr.repo, number: pr.number });
  }
}
