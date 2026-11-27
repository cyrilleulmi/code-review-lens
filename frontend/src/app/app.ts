import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { AccountCookie } from './account-cookie';
import { CertificateDialog } from './certificates';
import { PrKey, isTestsView, prLabel, providerInfo } from './api';
import { applyLang, lang, serverText, setLang, t } from './i18n';
import { applyTheme, theme, toggleTheme } from './theme';
import { CoverageOverview } from './coverage-overview';
import { RuleCheckOverview } from './rule-check-overview';
import { ScrollMemory, viewKey } from './scroll-memory';
import { FlowView } from './flow-view';
import { GroupView } from './group-view';
import { Icon } from './icon';
import { INSIGHTS, INSIGHTS_LABEL } from './insights';
import { InsightView } from './insight-view';
import { Overview } from './overview';
import { PrList } from './pr-list';
import { QuickOpen } from './quick-open';
import { StartPage } from './start-page';
import { ReviewStore, Slot } from './review.store';
import { ReviewTree } from './review-tree';
import { Workspace, prKeyOf, repoInitials, repoLabel, tabColor } from './workspace';

type ToolWindow = 'prs' | 'review' | null;

interface EditorContent {
  kind: 'overview' | 'group' | 'flow' | 'coverage' | 'insight';
  /** id of the view across the pull request (kind insight) */
  insight?: string;
  title?: string;
  description?: string | null;
  details?: { builds?: string | null; divides?: string | null } | null;
  icon?: string;
  slots?: Slot[];
  scope?: string;
  /** group view of the test category: shows the coverage of the changed code */
  coverage?: boolean;
  crumbs: string[];
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Icon, PrList, ReviewTree, Overview, GroupView, FlowView, InsightView, CoverageOverview, RuleCheckOverview, AccountCookie, CertificateDialog, QuickOpen, StartPage,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(ReviewStore);
  private readonly workspace = inject(Workspace);
  protected readonly tool = signal<ToolWindow>('prs');
  /** The stripe at the left edge is unfolded: the tabs show the titles of their pull requests. Kept per browser. */
  protected readonly stripeWide = signal(readFlag('scr.stripeWide'));
  /** The tabs of the open pull requests as the stripe shows them. */
  protected readonly tabs = computed<StripeTab[]>(() => {
    const open = this.store.prKey();
    return this.workspace.tabs().map((tab) => {
      const no = tab.number === 0 ? 'repo' : providerInfo(tab.provider).sigil + tab.number;
      return {
        provider: tab.provider, owner: tab.owner, repo: tab.repo, number: tab.number, title: tab.title,
        key: prKeyOf(tab), current: !!open && prKeyOf(open) === prKeyOf(tab), css: tabColor(tab.color),
        initials: repoInitials(tab.repo), no,
        tip: `${tab.title}\n${repoLabel(tab)} ${tab.number === 0 ? t('ganzes Repository') : no}\n${t('Mittlere Maustaste: Tab schliessen')}`,
      };
    });
  });
  /** The colour of the pull request that is shown (its tab, its entry in the lists, the toolbar). */
  protected readonly currentColor = computed(() => {
    const open = this.store.prKey();
    const tab = open ? this.workspace.tabOf(open) : null;
    return tab ? tabColor(tab.color) : null;
  });
  protected readonly toolWidth = signal(readWidth());
  /** Provider whose cookie dialog is open (accounts behind an SSO proxy, status bar). */
  protected readonly cookieFor = signal<string | null>(null);
  protected readonly cookieAccount = computed(
    () => this.store.me()?.accounts.find((a) => a.provider === this.cookieFor() && a.cookie != null) ?? null);

  /**
   * Accounts for the status bar: connected or set up somehow. A GitHub or GitLab of the startup configuration with
   * nothing set is left out, like in the connection panel.
   */
  protected readonly statusAccounts = computed(() => {
    const connections = this.store.connections() ?? [];
    return (this.store.me()?.accounts ?? []).filter((a) => {
      const c = connections.find((x) => x.provider === a.provider);
      return !c || !!a.user || c.token || c.saved || c.added;
    });
  });

  /** Providers whose connection the config page can change (status bar: a click opens it). */
  protected readonly configurable = computed(() => new Set((this.store.connections() ?? []).map((c) => c.provider)));
  /** Pull requests that wait for my review: the number at the button of the list. */
  protected readonly waiting = computed(() => this.store.prs().filter((p) => p.roles.includes('review-requested')).length);

  protected readonly flow = computed(() => {
    const sel = this.store.selection();
    return sel.kind === 'flow' ? this.store.bundle()?.analysis.flows.find((f) => f.id === sel.id) ?? null : null;
  });

  /** What the editor area shows for the current selection. */
  protected readonly content = computed<EditorContent | null>(() => {
    const b = this.store.bundle();
    if (!b) return null;
    const sel = this.store.selection();
    const cats = b.analysis.categories;
    switch (sel.kind) {
      case 'overview':
        return { kind: 'overview', crumbs: [t(INSIGHTS_LABEL), t('Übersicht')] };
      case 'category': {
        const c = cats.find((x) => x.id === sel.id)!;
        const label = serverText(c.label);
        return {
          kind: 'group', title: label, description: serverText(c.description), details: c, icon: c.icon,
          slots: this.store.slotsFor(sel), scope: `category:${c.id}`, crumbs: [label], coverage: isTestsView(c),
        };
      }
      case 'group': {
        const c = cats.find((x) => x.groups.some((g) => g.id === sel.id))!;
        const g = c.groups.find((x) => x.id === sel.id)!;
        return {
          kind: 'group', title: serverText(g.label), description: serverText(g.description ?? c.description), details: c,
          icon: c.id === 'logic' || c.id === 'tests' ? 'file' : c.icon,
          slots: this.store.slotsFor(sel), scope: `group:${g.id}`, crumbs: [serverText(c.label), serverText(g.label)],
        };
      }
      case 'flow': {
        const f = b.analysis.flows.find((x) => x.id === sel.id)!;
        return { kind: 'flow', crumbs: [t('Datenflüsse'), serverText(f.title)] };
      }
      case 'file': {
        const f = b.files.find((x) => x.path === sel.path);
        return {
          kind: 'group', title: sel.path, icon: 'file',
          description: f ? `${statusLabel(f.status)} · +${f.additions} −${f.deletions}` : null,
          slots: this.store.slotsFor(sel), scope: `file:${sel.path}`, crumbs: [t('Dateien'), ...sel.path.split('/')],
        };
      }
      case 'coverage':
        return { kind: 'coverage', crumbs: [t(INSIGHTS_LABEL), t('Abdeckung')] };
      case 'insight':
        return { kind: 'insight', insight: sel.id, crumbs: [t(INSIGHTS_LABEL), t(INSIGHTS.find((i) => i.id === sel.id)?.label ?? sel.id)] };
    }
  });

  protected readonly prLabel = prLabel;
  protected readonly t = t;
  protected readonly serverText = serverText;
  protected readonly lang = lang;
  protected readonly setLang = setLang;
  protected readonly theme = theme;
  protected readonly toggleTheme = toggleTheme;
  private dragStart: { x: number; width: number } | null = null;

  private readonly injector = inject(Injector);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly scrolls = new ScrollMemory();
  /** The view the editor shows; its scroll position is remembered separately from every other view. */
  private readonly view = computed(() => {
    const pr = this.store.prKey();
    return pr ? viewKey(pr, this.store.selection()) : null;
  });

  constructor() {
    applyLang();
    applyTheme();
    this.store.init();

    // Remember where each view is scrolled to (a plain listener: scrolling needs no change detection).
    effect((onCleanup) => {
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      const remember = () => {
        const key = untracked(this.view);
        if (key) this.scrolls.save(key, el.scrollTop);
      };
      el.addEventListener('scroll', remember, { passive: true });
      onCleanup(() => el.removeEventListener('scroll', remember));
    });
    // Another view: open it where it was left (at the top the first time), unless it is opened to show a block.
    effect(() => {
      const key = this.view();
      untracked(() => {
        const el = this.scroller()?.nativeElement;
        if (!el || !key) return;
        el.scrollTop = 0;
        const top = this.store.focusSegment() ? 0 : this.scrolls.positionOf(key);
        if (top > 0) {
          afterNextRender({ write: () => {
            if (this.view() === key) el.scrollTop = top;
          } }, { injector: this.injector });
        }
      });
    });
    // Switch to the review tool window whenever another PR has been opened, and back to the list when it is closed.
    let lastPr: string | null = null;
    effect(() => {
      const key = this.store.prKey();
      const id = key ? prLabel(key) : null;
      if (id && id !== lastPr) {
        untracked(() => this.tool.set('review'));
      } else if (!id && lastPr) {
        untracked(() => this.tool.set('prs'));
      }
      lastPr = id;
    });
    // A search handed to the list of pull requests (quick switch) shows the list.
    effect(() => {
      if (this.store.searchRequest()) {
        untracked(() => this.tool.set('prs'));
      }
    });
    // The tab of the browser (and its history) says what is open.
    effect(() => {
      const pr = this.store.bundle()?.pr;
      document.title = pr
        ? (pr.number === 0 ? t('Ganzes Repository') : this.store.provider().sigil + pr.number + ' ' + pr.title) + ' · ' + pr.repo + ' – CodeReviewLens'
        : 'CodeReviewLens';
    });
    // The connections live at the top of the pull request tool window: opening them (toolbar, status bar) shows it.
    effect(() => {
      if (this.store.connectionsOpen()) {
        untracked(() => this.tool.set('prs'));
      }
    });
  }

  /** The start page: closes the pull request (back of the browser returns to it) and shows the list. */
  protected home(): void {
    if (this.store.bundle()) {
      this.store.close();
    }
    this.tool.set('prs');
  }

  /** The tab of the pull request shown folds its review window in and out; another tab shows its pull request. */
  protected tabClick(tab: PrKey): void {
    const open = this.store.prKey();
    if (open && prKeyOf(open) === prKeyOf(tab)) {
      this.toggleTool('review');
    } else {
      this.store.activate(tab);
    }
  }

  /** The middle mouse button closes a tab, as in a browser: pressed it does nothing (no scrolling), released it closes. */
  protected tabMiddle(event: MouseEvent, tab?: PrKey): void {
    if (event.button === 1) {
      event.preventDefault();
      if (tab) {
        this.store.closeTab(tab);
      }
    }
  }

  protected toggleStripe(): void {
    const wide = !this.stripeWide();
    this.stripeWide.set(wide);
    try {
      localStorage.setItem('scr.stripeWide', String(wide));
    } catch {
      // storage unavailable - the stripe is just folded again next time
    }
  }

  protected toggleTool(t: ToolWindow): void {
    this.tool.set(this.tool() === t ? null : t);
  }

  protected toggleCookie(provider: string): void {
    this.cookieFor.set(this.cookieFor() === provider ? null : provider);
  }

  protected startDrag(event: PointerEvent): void {
    this.dragStart = { x: event.clientX, width: this.toolWidth() };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected drag(event: PointerEvent): void {
    if (this.dragStart) {
      this.toolWidth.set(Math.min(640, Math.max(220, this.dragStart.width + event.clientX - this.dragStart.x)));
    }
  }

  protected endDrag(): void {
    this.dragStart = null;
    try {
      localStorage.setItem('scr.toolWidth', String(this.toolWidth()));
    } catch {
      // storage unavailable - the width is just not remembered
    }
  }

  @HostListener('window:keydown', ['$event'])
  protected shortcuts(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.store.quickOpen.set(!this.store.quickOpen());
    } else if (event.altKey && event.key === '1') {
      event.preventDefault();
      this.toggleTool('prs');
    } else if (event.altKey && event.key === '2' && this.store.bundle()) {
      event.preventDefault();
      this.toggleTool('review');
    }
  }
}

/** A tab of the stripe: the pull request with its colour as a CSS value and its short texts. */
interface StripeTab extends PrKey {
  title: string;
  key: string;
  current: boolean;
  /** its colour as a CSS value */
  css: string;
  initials: string;
  /** "#17", "!4347", "repo" for a whole repository */
  no: string;
  tip: string;
}

function readFlag(name: string): boolean {
  try {
    return localStorage.getItem(name) === 'true';
  } catch {
    return false;
  }
}

function readWidth(): number {
  try {
    return Number(localStorage.getItem('scr.toolWidth')) || 330;
  } catch {
    return 330;
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { added: t('Neu'), removed: t('Gelöscht'), modified: t('Geändert'), renamed: t('Umbenannt') };
  return labels[status] ?? status;

}
