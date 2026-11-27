import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { Api, PullRequestSummary } from './api';
import { Icon } from './icon';
import { pastedUrl } from './pasted-url';
import { t } from './i18n';
import { PrEntry, PrItem } from './pr-item';
import { ReviewStore } from './review.store';
import { RepoRef, Workspace, matchesQuery, prKeyOf, repoKey, repoLabel } from './workspace';

/** A row of the quick switch: a pull request under the heading of its section, or something to do. */
type Row =
  | { kind: 'pr'; key: string; section: string; pr: PrEntry; showRepo: boolean }
  | { kind: 'action'; key: string; section: string; icon: string; label: string; run: () => void };

/** How many pull requests a section shows while nothing is typed. */
const SECTION_MAX = 8;

/**
 * The quick switch to another pull request (toolbar, Ctrl+K): one field over everything one can go to from here -
 * the other open pull requests of the repository one is in, what was opened last, the pinned repositories, my pull
 * requests. Typing narrows it, a pasted URL opens it, the arrow keys and Enter choose; a search in all repositories
 * is handed to the list.
 */
@Component({
  selector: 'app-quick-open',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PrItem],
  template: `
    <div class="backdrop" (click)="close()"></div>
    <div class="panel" role="dialog" aria-modal="true" [attr.aria-label]="t('Pull/Merge Request wechseln')" (keydown)="keys($event)">
      <div class="field">
        <app-icon name="search" [size]="15" />
        <input #input type="search" autocomplete="off" spellcheck="false" [placeholder]="t('Pull/Merge Request suchen oder URL einfügen …')"
               [value]="query()" (input)="type($any($event.target).value)" />
        <kbd>Esc</kbd>
      </div>
      @if (here(); as r) {
        <div class="here">
          <app-icon [name]="r.provider" [size]="13" />
          <span class="name">{{ label(r) }}</span>
          <span class="spacer"></span>
          <button type="button" class="pin" [class.on]="ws.isPinned(r)" [attr.aria-pressed]="ws.isPinned(r)" (click)="ws.togglePin(r)">
            <app-icon name="pin" [size]="13" />
            {{ ws.isPinned(r) ? t('Angepinnt') : t('Repository anpinnen') }}
          </button>
        </div>
      }
      <div class="rows" #rowsEl>
        @for (row of rows(); track row.key; let i = $index) {
          @if (i === 0 || rows()[i - 1].section !== row.section) {
            <h4>{{ row.section }}</h4>
          }
          @if (row.kind === 'pr') {
            <app-pr-item [pr]="row.pr" [showRepo]="row.showRepo" [active]="i === index()" [attr.data-row]="i" (mousemove)="index.set(i)" />
          } @else {
            <button type="button" class="action" [class.active]="i === index()" [attr.data-row]="i" (click)="row.run()" (mousemove)="index.set(i)">
              <app-icon [name]="row.icon" [size]="14" /> {{ row.label }}
            </button>
          }
        } @empty {
          <p class="empty">{{ loading() ? t('Lade Repository …') : t('Keine Treffer.') }}</p>
        }
      </div>
      <div class="foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> {{ t('wählen') }}</span>
        <span><kbd>Enter</kbd> {{ t('öffnen') }}</span>
        <span class="spacer"></span>
        <span><kbd>{{ t('Strg') }}</kbd>+<kbd>K</kbd> {{ t('öffnet diesen Wechsel von überall') }}</span>
      </div>
    </div>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 1200; display: flex; justify-content: center; align-items: flex-start; padding-top: 9vh; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop); }
    .panel { position: relative; display: flex; flex-direction: column; width: min(680px, calc(100vw - 32px)); max-height: 76vh;
      border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-panel); box-shadow: var(--shadow-popup); overflow: hidden; }
    .field { display: flex; align-items: center; gap: 9px; padding: 0 14px; height: 46px; border-bottom: 1px solid var(--border); color: var(--fg-dim); }
    .field input { flex: 1; min-width: 0; border: 0; background: none; color: var(--fg); font: 400 14px var(--font-ui); outline: none; }
    kbd { padding: 1px 5px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-panel-2); color: var(--fg-muted); font: 500 10.5px var(--font-ui); }
    .here { display: flex; align-items: center; gap: 7px; padding: 6px 14px; border-bottom: 1px solid var(--border); background: var(--bg-panel-2); color: var(--fg-muted); font-size: 12px; }
    .here .name { font-weight: 600; color: var(--fg); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spacer { flex: 1; }
    .pin { display: inline-flex; flex: none; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: 12px;
      background: none; color: var(--fg-muted); font: 500 11.5px var(--font-ui); cursor: pointer; }
    .pin:hover { color: var(--fg); background: var(--bg-hover); }
    .pin.on { border-color: var(--cat-amber); color: var(--cat-amber); }
    .rows { flex: 1; overflow: auto; padding: 4px 8px 8px; }
    h4 { margin: 10px 8px 3px; color: var(--fg-dim); font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .action { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: 6px; background: none; color: var(--accent-fg);
      font: 500 13px var(--font-ui); text-align: left; cursor: pointer; }
    .action.active, .action:hover { background: var(--bg-hover); }
    .empty { padding: 14px 10px; color: var(--fg-dim); font-size: 12.5px; }
    .foot { display: flex; align-items: center; gap: 14px; padding: 7px 14px; border-top: 1px solid var(--border); background: var(--bg-panel-2); color: var(--fg-dim); font-size: 11.5px; }
    .foot kbd { margin-right: 2px; }
  `,
})
export class QuickOpen {
  protected readonly store = inject(ReviewStore);
  protected readonly ws = inject(Workspace);
  private readonly api = inject(Api);
  protected readonly t = t;
  protected readonly label = repoLabel;
  protected readonly query = signal('');
  /** the row the keyboard is at */
  protected readonly index = signal(0);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private readonly rowsEl = viewChild.required<ElementRef<HTMLElement>>('rowsEl');

  /** The repository of the pull request that is open. */
  protected readonly here = computed<RepoRef | null>(() => {
    const key = this.store.prKey();
    return key ? { provider: key.provider, owner: key.owner, repo: key.repo } : null;
  });
  /** Its open pull requests, fetched when the switch opens. */
  private readonly siblings = signal<PullRequestSummary[]>([]);
  protected readonly loading = signal(false);

  protected readonly rows = computed<Row[]>(() => {
    const raw = this.query();
    const url = pastedUrl(raw);
    if (url) {
      return [{ kind: 'action', key: 'url', section: t('URL'), icon: 'arrowRight', label: t('URL öffnen'), run: () => this.openUrl(url) }];
    }
    const q = raw.trim();
    const rows: Row[] = [];
    // each pull request once; the one that is open is not somewhere to switch to
    const seen = new Set<string>();
    const open = this.store.prKey();
    if (open) {
      seen.add(prKeyOf(open));
    }
    const add = (section: string, list: readonly PrEntry[], showRepo: boolean, max = SECTION_MAX) => {
      const fresh = list.filter((p) => matchesQuery(p, q) && !seen.has(prKeyOf(p)));
      (q ? fresh : fresh.slice(0, max)).forEach((pr) => {
        seen.add(prKeyOf(pr));
        rows.push({ kind: 'pr', key: section + prKeyOf(pr), section, pr, showRepo });
      });
    };
    const here = this.here();
    if (here) {
      const section = t('In diesem Repository');
      add(section, this.siblings(), false, 20);
      if (!this.store.isRepo() && (!q || matchesQuery({ ...here, number: 0, title: t('Ganzes Repository analysieren') }, q))) {
        rows.push({ kind: 'action', key: 'whole', section, icon: 'folder', label: t('Ganzes Repository analysieren'), run: () => this.store.openRepository() });
      }
    }
    add(t('Zuletzt geöffnet'), this.ws.recent(), true);
    const pinned = this.ws.pinnedPrs();
    for (const repo of this.ws.pinned()) {
      if (!here || repoKey(repo) !== repoKey(here)) {
        add(repoLabel(repo), pinned.get(repoKey(repo))?.prs ?? [], false);
      }
    }
    add(t('Meine Pull/Merge Requests'), this.store.prs(), true, 20);
    if (q.length >= 2) {
      rows.push({
        kind: 'action', key: 'search', section: t('Mehr'), icon: 'search',
        label: t('«{query}» in allen Repositories suchen', { query: q }), run: () => this.searchEverywhere(q),
      });
    }
    return rows;
  });

  constructor() {
    afterNextRender(() => this.input().nativeElement.focus());
    const here = this.here();
    if (here) {
      this.loading.set(true);
      this.api.repoPrs(here).subscribe({
        next: (prs) => {
          this.siblings.set(prs);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    }
  }

  protected type(value: string): void {
    this.query.set(value);
    this.index.set(0);
  }

  protected close(): void {
    this.store.quickOpen.set(false);
  }

  protected keys(event: KeyboardEvent): void {
    const rows = this.rows();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(rows.length - 1, Math.max(0, this.index() + (event.key === 'ArrowDown' ? 1 : -1)));
      this.index.set(next);
      this.rowsEl().nativeElement.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[this.index()];
      if (row?.kind === 'pr') {
        this.store.open({ provider: row.pr.provider, owner: row.pr.owner, repo: row.pr.repo, number: row.pr.number });
      } else {
        row?.run();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  private openUrl(url: string): void {
    this.close();
    this.store.openUrl(url);
  }

  private searchEverywhere(query: string): void {
    this.close();
    this.store.searchFor(query);
  }
}
