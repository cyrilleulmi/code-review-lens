import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Icon } from './icon';
import { t } from './i18n';
import { PrItem } from './pr-item';
import { ReviewStore } from './review.store';
import { Workspace, groupByRepo, repoKey, repoLabel } from './workspace';

/** How many pull requests a column of the start page shows; the rest is in the list. */
const SHOWN = 6;

/**
 * The start page - what the editor shows while no pull request is open: where to go on (what was opened last), what
 * waits for my review, and the pinned repositories with their open pull requests. Closing a pull request, the home
 * button and "back" of the browser lead here.
 */
@Component({
  selector: 'app-start-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PrItem],
  template: `
    <header class="hero">
      <div class="mark">CL</div>
      <div class="titles">
        <h1>CodeReviewLens</h1>
        <p>{{ t('Reviews nach Bedeutung statt nach Dateien: zuerst die Quick wins abhaken, dann die Datenflüsse am Stück lesen.') }}</p>
      </div>
    </header>

    @if (store.loading(); as l) {
      <p class="loading"><span class="spinner"></span> {{ l }}</p>
    } @else {
      <button type="button" class="jump" (click)="store.quickOpen.set(true)">
        <app-icon name="search" [size]="15" />
        <span>{{ t('Pull/Merge Request suchen oder URL einfügen …') }}</span>
        <kbd>{{ t('Strg') }}</kbd>+<kbd>K</kbd>
      </button>
      @if (noAccount()) {
        <p class="connect">
          <button type="button" class="btn primary" (click)="store.connectionsOpen.set(true)"><app-icon name="plug" [size]="14" /> {{ t('Code-Host verbinden') }}</button>
          <span>{{ t('Ohne Verbindung lassen sich öffentliche Pull Requests per URL öffnen.') }}</span>
        </p>
      }

      <div class="columns">
        @if (recent().length) {
          <section>
            <h2><app-icon name="refresh" [size]="14" /> {{ t('Weiter reviewen') }}</h2>
            @for (pr of recent(); track key(pr)) {
              <app-pr-item [pr]="pr" />
            }
          </section>
        }
        @if (waiting().length) {
          <section>
            <h2><app-icon name="review" [size]="14" /> {{ t('Wartet auf dein Review') }} <span class="badge">{{ waitingTotal() }}</span></h2>
            @for (pr of waiting(); track pr.url) {
              <app-pr-item [pr]="pr" />
            }
          </section>
        }
        @for (g of pinned(); track g.key) {
          <section>
            <h2 [title]="label(g.repo)">
              <app-icon name="pin" [size]="14" class="pinned" /> <span class="name">{{ label(g.repo) }}</span> <span class="badge">{{ g.total }}</span>
            </h2>
            @for (pr of g.prs; track pr.url) {
              <app-pr-item [pr]="pr" [showRepo]="false" />
            } @empty {
              <p class="empty">{{ g.error ?? (g.loading ? t('Lade Repository …') : t('Keine offenen Pull/Merge Requests in diesem Repository.')) }}</p>
            }
            @if (g.total > g.prs.length) {
              <p class="more">{{ t('+{n} weitere in der Liste', { n: g.total - g.prs.length }) }}</p>
            }
          </section>
        }
        @if (mine().length) {
          <section>
            <h2><app-icon name="pr" [size]="14" /> {{ t('Meine Pull/Merge Requests') }} <span class="badge">{{ mineTotal() }}</span></h2>
            @for (pr of mine(); track pr.url) {
              <app-pr-item [pr]="pr" />
            }
            @if (mineTotal() > mine().length) {
              <p class="more">{{ t('+{n} weitere in der Liste', { n: mineTotal() - mine().length }) }}</p>
            }
          </section>
        }
      </div>

      @if (!pinned().length && !noAccount()) {
        <p class="tip"><app-icon name="pin" [size]="13" /> {{ t('Tipp: Pinne ein Repository an (Nadel in der Liste), dann stehen seine offenen Pull/Merge Requests immer hier – auch die, an denen du nicht beteiligt bist.') }}</p>
      }
      <p class="keys"><kbd>Alt</kbd>+<kbd>1</kbd> {{ t('Liste') }} · <kbd>Alt</kbd>+<kbd>2</kbd> Review · <kbd>{{ t('Strg') }}</kbd>+<kbd>K</kbd> {{ t('wechseln') }} ·
        {{ t('«Zurück» des Browsers führt zur vorherigen Ansicht') }}</p>
    }
  `,
  styles: `
    :host { display: block; width: 100%; max-width: 1180px; margin: 0 auto; padding: 28px 28px 40px; box-sizing: border-box; }
    .hero { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
    .mark { display: grid; flex: none; place-items: center; width: 52px; height: 52px; border-radius: 14px; background: var(--brand-gradient); color: var(--on-ok-all);
      font-size: 20px; font-weight: 700; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    .titles p { margin: 0; color: var(--fg-muted); line-height: 1.5; }
    .loading { color: var(--fg-muted); }
    .jump { display: flex; align-items: center; gap: 9px; width: 100%; max-width: 620px; height: 40px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--bg-panel-2); color: var(--fg-dim); font: 400 13.5px var(--font-ui); text-align: left; cursor: text; }
    .jump:hover { border-color: var(--accent); color: var(--fg-muted); }
    .jump span { flex: 1; }
    kbd { padding: 1px 5px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-panel); color: var(--fg-muted); font: 500 10.5px var(--font-ui); }
    .connect { display: flex; align-items: center; gap: 12px; margin: 14px 0 0; color: var(--fg-dim); font-size: 12.5px; }
    .columns { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 16px; margin-top: 22px; align-items: start; }
    section { min-width: 0; padding: 10px 8px 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel-2); }
    h2 { display: flex; align-items: center; gap: 7px; margin: 0 6px 6px; font-size: 12.5px; font-weight: 600; color: var(--fg-muted); }
    h2 .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    h2 .pinned { color: var(--cat-amber); }
    .badge { padding: 1px 6px; border-radius: 8px; background: var(--bg-hover); font-size: 10.5px; font-weight: 500; }
    .empty, .more { margin: 4px 8px; color: var(--fg-dim); font-size: 12px; }
    .tip { display: flex; gap: 7px; max-width: 760px; margin: 22px 0 0; color: var(--fg-dim); font-size: 12.5px; line-height: 1.5; }
    .tip app-icon { flex: none; margin-top: 3px; }
    .keys { margin: 18px 0 0; color: var(--fg-dim); font-size: 12px; }
  `,
})
export class StartPage {
  protected readonly store = inject(ReviewStore);
  private readonly ws = inject(Workspace);
  protected readonly t = t;
  protected readonly label = repoLabel;

  /** No code host is connected: the page offers the connections. */
  protected readonly noAccount = computed(() => {
    const me = this.store.me();
    return !!me && !me.accounts.some((a) => a.user);
  });
  protected readonly recent = computed(() => this.ws.recent().slice(0, SHOWN));
  private readonly waitingAll = computed(() => this.store.prs().filter((p) => p.roles.includes('review-requested')));
  protected readonly waitingTotal = computed(() => this.waitingAll().length);
  protected readonly waiting = computed(() => this.waitingAll().slice(0, SHOWN));
  protected readonly pinned = computed(() => {
    const loaded = this.ws.pinnedPrs();
    return this.ws.pinned().map((repo) => {
      const state = loaded.get(repoKey(repo));
      const all = [...(state?.prs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { key: repoKey(repo), repo, prs: all.slice(0, SHOWN), total: all.length, loading: state?.loading ?? true, error: state?.error ?? null };
    });
  });
  /** My pull requests outside the pinned repositories, the ones changed last first. */
  private readonly mineAll = computed(() => {
    const pinned = new Set(this.ws.pinned().map(repoKey));
    return groupByRepo(this.store.prs().filter((p) => !pinned.has(repoKey(p)) && !p.roles.includes('review-requested')))
      .flatMap((g) => g.prs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
  protected readonly mineTotal = computed(() => this.mineAll().length);
  protected readonly mine = computed(() => this.mineAll().slice(0, SHOWN));

  protected key(pr: { provider: string; owner: string; repo: string; number: number }): string {
    return `${repoKey(pr)}/${pr.number}`;
  }
}
