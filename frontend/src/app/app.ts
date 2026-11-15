import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { isTestsView, prLabel } from './api';
import { applyLang, lang, serverText, setLang, t } from './i18n';
import { CoverageOverview } from './coverage-overview';
import { RuleCheckOverview } from './rule-check-overview';
import { ScrollMemory, viewKey } from './scroll-memory';
import { FlowView } from './flow-view';
import { GroupView } from './group-view';
import { Icon } from './icon';
import { Overview } from './overview';
import { PrList } from './pr-list';
import { ReviewStore, Slot } from './review.store';
import { ReviewTree } from './review-tree';

type ToolWindow = 'prs' | 'review' | null;

interface EditorContent {
  kind: 'overview' | 'group' | 'flow' | 'coverage';
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
  imports: [Icon, PrList, ReviewTree, Overview, GroupView, FlowView, CoverageOverview, RuleCheckOverview],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(ReviewStore);
  protected readonly tool = signal<ToolWindow>('prs');
  protected readonly toolWidth = signal(readWidth());

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
        return { kind: 'overview', crumbs: [t('Übersicht')] };
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
        return { kind: 'coverage', crumbs: [t('Abdeckung')] };
    }
  });

  protected readonly prLabel = prLabel;
  protected readonly t = t;
  protected readonly serverText = serverText;
  protected readonly lang = lang;
  protected readonly setLang = setLang;
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
    // Switch to the review tool window whenever another PR has been opened.
    let lastPr: string | null = null;
    effect(() => {
      const key = this.store.prKey();
      const id = key ? prLabel(key) : null;
      if (id && id !== lastPr) {
        untracked(() => this.tool.set('review'));
      }
      lastPr = id;
    });
  }

  protected toggleTool(t: ToolWindow): void {
    this.tool.set(this.tool() === t ? null : t);
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
    if (event.altKey && event.key === '1') {
      event.preventDefault();
      this.toggleTool('prs');
    } else if (event.altKey && event.key === '2' && this.store.bundle()) {
      event.preventDefault();
      this.toggleTool('review');
    }
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
