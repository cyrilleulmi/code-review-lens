import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { PrKey, PrRole, providerInfo } from './api';
import { Icon } from './icon';
import { t } from './i18n';
import { ReviewStore } from './review.store';
import { Workspace, prKeyOf, relativeTime, repoLabel, tabColor } from './workspace';

/** A pull request as the lists show it: one from a code host, or one remembered as opened here. */
export interface PrEntry extends PrKey {
  title: string;
  author?: string;
  draft?: boolean;
  roles?: PrRole[];
  progress?: { ok: number; total: number } | null;
  updatedAt?: string;
  /** when it was opened here last (the lists of what was opened) */
  openedAt?: string;
}

/**
 * One pull request in a list (tool window, start page, quick switch): title, repository, number, author, my part in
 * it, when it changed and how far its review is. A click opens it; the one that is open is marked.
 */
@Component({
  selector: 'app-pr-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let p = pr();
    <button type="button" class="item" [class.selected]="current()" [class.active]="active()" [class.tabbed]="!!color()" [style.--tab]="color()"
            (click)="open()" [title]="tip()">
      <span class="line1">
        <app-icon [name]="p.number === 0 ? 'folder' : p.provider" [size]="14" [class]="draft() ? 'draft' : 'open'" />
        <span class="title">{{ p.title }}</span>
        @if (current()) {
          <span class="here">{{ t('geöffnet') }}</span>
        }
      </span>
      <span class="line2">
        @if (showRepo()) {
          <span class="repo" [title]="repo()">{{ p.repo }}</span>
        }
        <span>{{ p.number === 0 ? t('ganzes Repository') : sigil() + p.number }}</span>
        @if (p.author) {
          <span>· {{ p.author }}</span>
        }
        @for (r of roles(); track r) {
          <span class="role" [class]="'role r-' + r">{{ roleLabel(r) }}</span>
        }
        @if (draft()) {
          <span class="role">{{ t('Entwurf') }}</span>
        }
        @if (when(); as w) {
          <span class="when" [title]="w.title">{{ w.text }}</span>
        }
        @if (progress(); as g) {
          <span class="prog" [title]="t('{ok}/{total} Zeilen ok', { ok: g.ok, total: g.total })">
            <span class="bar"><span [style.width.%]="g.total ? (g.ok / g.total) * 100 : 0"></span></span>
            {{ g.total ? percent(g) : '' }}
          </span>
        }
      </span>
    </button>
  `,
  styles: `
    :host { display: block; }
    .item { display: flex; flex-direction: column; gap: 3px; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; background: none;
      color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
    .item:hover, .item.active { background: var(--bg-hover); }
    .item.selected { background: var(--bg-selected); }
    /* open as a tab: the colour of its tab at the left edge, and as the ground of the one that is shown */
    .item.tabbed { box-shadow: inset 3px 0 0 var(--tab); }
    .item.tabbed.selected { background: color-mix(in srgb, var(--tab) 20%, transparent); }
    .item.tabbed .here { background: var(--tab); color: var(--on-fill); }
    .line1 { display: flex; gap: 6px; align-items: flex-start; }
    .line1 .open { color: var(--ok); margin-top: 1px; flex: none; }
    .line1 .draft { color: var(--fg-dim); margin-top: 1px; flex: none; }
    .title { flex: 1; min-width: 0; font-size: 13px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .here { flex: none; padding: 1px 6px; border-radius: 8px; background: var(--accent); color: var(--on-ok-all); font-size: 10px; font-weight: 600; }
    .line2 { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; padding-left: 20px; color: var(--fg-dim); font-size: 11.5px; }
    .repo { color: var(--fg-muted); }
    .role { padding: 0 5px; border-radius: 3px; font-size: 10.5px; background: var(--bg-hover); }
    .role.r-review-requested { background: color-mix(in srgb, var(--cat-amber) 18%, transparent); color: var(--cat-amber); }
    .role.r-involved { background: color-mix(in srgb, var(--accent-fg) 18%, transparent); color: var(--accent-fg); }
    .prog { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; font-size: 10.5px; font-variant-numeric: tabular-nums; }
    .prog .bar { display: inline-block; width: 40px; height: 4px; border-radius: 2px; background: var(--bg-hover); overflow: hidden; }
    .item.selected .prog .bar, .item:hover .prog .bar { background: var(--border-strong); }
    .prog .bar span { display: block; height: 100%; background: var(--ok-all); }
  `,
})
export class PrItem {
  private readonly store = inject(ReviewStore);
  private readonly workspace = inject(Workspace);
  readonly pr = input.required<PrEntry>();
  /** the repository in the second line (not needed below the heading of its repository) */
  readonly showRepo = input(true);
  /** the entry the keyboard is at (quick switch) */
  readonly active = input(false);
  protected readonly t = t;

  /** What the list of my pull requests knows about it (my part, progress), for entries that do not say. */
  private readonly known = computed(() => {
    const key = prKeyOf(this.pr());
    return this.store.prs().find((p) => prKeyOf(p) === key);
  });
  protected readonly current = computed(() => {
    const open = this.store.prKey();
    return !!open && prKeyOf(open) === prKeyOf(this.pr());
  });
  /** The colour of its tab while it is open as one. */
  protected readonly color = computed(() => {
    const tab = this.workspace.tabOf(this.pr());
    return tab ? tabColor(tab.color) : null;
  });
  protected readonly tip = computed(() => this.pr().title + (this.color() && !this.current() ? '\n' + t('Offen als Tab') : ''));
  protected readonly roles = computed(() => (this.pr().roles?.length ? this.pr().roles! : this.known()?.roles ?? []));
  protected readonly draft = computed(() => this.pr().draft ?? this.known()?.draft ?? false);
  protected readonly progress = computed(() => this.pr().progress ?? this.known()?.progress ?? null);
  protected readonly sigil = computed(() => providerInfo(this.pr().provider).sigil);
  protected readonly repo = computed(() => repoLabel(this.pr()));
  /** When it was opened here, else when it changed on the code host. */
  protected readonly when = computed(() => {
    const p = this.pr();
    const now = new Date();
    if (p.openedAt) {
      return { text: relativeTime(p.openedAt, now), title: t('Zuletzt hier geöffnet: {when}', { when: new Date(p.openedAt).toLocaleString() }) };
    }
    return p.updatedAt ? { text: relativeTime(p.updatedAt, now), title: t('Zuletzt geändert: {when}', { when: new Date(p.updatedAt).toLocaleString() }) } : null;
  });

  protected percent(g: { ok: number; total: number }): string {
    return Math.floor((g.ok / g.total) * 100) + ' %';
  }

  protected roleLabel(role: string): string {
    return role === 'authored' ? t('von mir') : role === 'involved' ? t('beteiligt') : t('Review');
  }

  open(): void {
    const p = this.pr();
    this.store.open({ provider: p.provider, owner: p.owner, repo: p.repo, number: p.number });
  }
}
