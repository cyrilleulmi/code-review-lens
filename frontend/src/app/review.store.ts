import { Injectable, computed, inject, signal } from '@angular/core';
import {
  CertificateTarget,
  TlsSettings,
  Api,
  Blame,
  CodeCoverage,
  Comment,
  Commit,
  Commits,
  Component,
  Connection,
  LineMark,
  LogEntry,
  Me,
  MergeOptions,
  NewComment,
  PrKey,
  PrStatus,
  PullRequestSummary,
  ReloadInfo,
  ReviewBundle,
  ReviewState,
  Segment,
  SetupImpact,
  SpecEntry,
  TestInfo,
  WholeFile,
  errorMessage,
  isTestsView,
  prLabel,
  providerInfo,
} from './api';
import { LineBoxes, everywhereTargets, lineBoxes } from './accept-boxes';
import { AcceptStatus, Acceptance, accept, statusOf } from './acceptance';
import { laterExpectationsByTest } from './commit-findings';
import { FlowCodeLevel, FlowDiagramLevel } from './flow-classes';
import { INSIGHTS } from './insights';
import { startSelection } from './start-selection';
import { METHOD_DETAILS, MethodDetail } from './method-detail';
import { OpenTab, Workspace } from './workspace';
import { groupWarnings, testNamer } from './mock-boundaries';
import { reloadMessage } from './reload-message';
import { serverText, t } from './i18n';

export type Selection =
  | { kind: 'overview' }
  | { kind: 'category'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'flow'; id: string }
  | { kind: 'file'; path: string }
  /** coverage of the changed code on its own page (when there is no switched-on test category to show it in) */
  | { kind: 'coverage' }
  /** a view across the whole pull request (insights.ts): components, metrics, fitness functions, ... */
  | { kind: 'insight'; id: string };

export type PrFilter = 'all' | 'authored' | 'review-requested' | 'involved';

export interface Progress {
  /** lines accepted at the place they are counted at (without a place: at all their places) */
  ok: number;
  total: number;
  /** lines accepted at all their places ("everywhere"); the same as ok when counted without a place */
  all: number;
  /** lines shown at several places: only for these "here" and "everywhere" are different things */
  multi: number;
}

/**
 * A segment as shown at one place (group id such as "quick-wins/mapper" or "flows/flow-2"). place null means
 * "everywhere" (file view, totals): a line only counts as ok there when it is ok at all its places.
 */
export interface Slot {
  segmentId: string;
  place: string | null;
}

export interface PlaceInfo {
  id: string;
  /** e.g. "Quick wins › Mapper", "Flow: update → validate" */
  label: string;
  categoryId: string;
  selection: Selection;
}

const SEP = '\u0000';

/** How code blocks show a diff: in one column or side by side. */
export type DiffMode = 'unified' | 'split';

/** The settings of the page of one flow (see ReviewStore.flowPage). */
export interface FlowPage {
  /** the sequence leaves out what is used rather than called (constants, types): only calls of functions and methods */
  callsOnly: boolean;
  /** level of the diagram; the default shows classes as frames with their methods inside */
  level: FlowDiagramLevel;
  /** own level of the code; null = the code follows the diagram (codeLevelFor) */
  code: FlowCodeLevel | null;
  /** areas (layers: frontend, api, logic, ...; '' = none) taken out of diagram and code, the flow is bridged around them */
  hiddenAreas: ReadonlySet<string>;
}

const FLOW_PAGE_DEFAULT: FlowPage = { callsOnly: false, level: 'combined', code: null, hiddenAreas: new Set() };

/** Commit filter value for "new or changed since my last review" (also in the URL: …/c/since-review). */
export const SINCE_REVIEW = 'since-review';

/** Central UI state (signals). Marks are applied optimistically and confirmed by the backend. */
@Injectable({ providedIn: 'root' })
export class ReviewStore {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  /** The quick switch to another pull request is open (toolbar, Ctrl+K). */
  readonly quickOpen = signal(false);
  /** A search handed to the list of pull requests (from the quick switch): it shows the list and searches there. */
  readonly searchRequest = signal<{ query: string; seq: number } | null>(null);
  /**
   * How the next change of the address is written: as a new entry of the browser history (back returns to the view
   * before), in place, or not at all - the address is already there (back / forward, see followAddress).
   */
  private historyMode: HistoryMode = 'push';
  private pendingHistory: HistoryMode = 'push';
  /** Where each open pull request was left (its address), by prLabel: its tab comes back to that view. */
  private readonly leftAt = new Map<string, string>();
  private prsLoadedAt = 0;

  readonly me = signal<Me | null>(null);
  /** Connections the config page can change (GitLab), null until loaded. */
  readonly connections = signal<Connection[] | null>(null);
  /** The connection form at the top of the pull request tool window is open (a host not connected shows it anyway). */
  readonly connectionsOpen = signal(false);
  /** The connection whose form is open (null: the chosen one, else the first). */
  readonly editedConnection = signal<string | null>(null);
  readonly prs = signal<PullRequestSummary[]>([]);
  readonly prsLoading = signal(false);
  readonly prFilter = signal<PrFilter>('all');
  /** The connection whose pull requests the list shows (id, e.g. "gitlab~git.example.com"); null: all of them. */
  readonly prHost = signal<string | null>(readText(PR_HOST_KEY));
  readonly bundle = signal<ReviewBundle | null>(null);
  readonly loading = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly toast = signal<string | null>(null);
  /** The host whose certificate dialog is open: a request failed on its certificate, or the user asked. */
  readonly certificateFor = signal<CertificateTarget | null>(null);
  /** Certificates trusted besides the default ones and hosts without check; null until «Zertifikate» was opened. */
  readonly tls = signal<TlsSettings | null>(null);
  /** lines ok at all their places ("path\0key") */
  readonly ok = signal<ReadonlySet<string>>(new Set());
  /** place -> lines ok at that place only */
  readonly okAt = signal<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  readonly comments = signal<Comment[]>([]);
  /** Where the PR stands on the code host (approvals, mergeable); null while unknown or where the host has no such thing. */
  readonly status = signal<PrStatus | null>(null);
  readonly log = signal<LogEntry[]>([]);
  readonly selection = signal<Selection>({ kind: 'overview' });
  readonly collapseDone = signal(true);
  /**
   * What the user set on the page of a flow, by flow id: the levels of diagram and code and the areas taken out. It
   * holds for that flow only and while its PR is open; nothing of it is stored, every flow starts with the defaults.
   */
  private readonly flowPages = signal<ReadonlyMap<string, FlowPage>>(new Map());
  /** "Collapse all" / "expand all" of the current view; code blocks follow it. Reset on navigation. */
  readonly collapseCommand = signal<{ collapsed: boolean; seq: number } | null>(null);
  /** Segment to scroll to after the next render (e.g. clicked in a flow diagram). */
  readonly focusSegment = signal<string | null>(null);
  /** Line (new file) to show within the focused block after the next render (e.g. a finding of the coverage view). */
  readonly focusLine = signal<{ segmentId: string; line: number } | null>(null);
  /** Commits of the open PR and which commit made each changed line (loaded after the bundle). */
  readonly commits = signal<Commits | null>(null);
  readonly commitsLoading = signal(false);
  /** Show only the changes of this commit (full sha), or SINCE_REVIEW; null = all changes of the PR. */
  readonly commitFilter = signal<string | null>(null);
  /** What the last reload with new commits did to the marks (from review.json). */
  readonly reloadInfo = signal<ReloadInfo | null>(null);
  /** git blame annotations in the code blocks ("Annotate with Git Blame" in IntelliJ). */
  readonly annotate = signal(readFlag('scr.annotate'));
  /**
   * Test enrichments in the code and flow views: coverage and test badges, "Testet / Getestet von" links, line chips
   * of the test analysis, test colouring of flow steps and connections. Off by default (switched on in the toolbar or
   * at the top of a flow); the Tests category and the test overview stay as they are.
   */
  readonly testInfo = signal(readFlag('scr.testInfo'));
  /**
   * How the code blocks show a diff: 'unified' = one column, deleted above added lines; 'split' = side by side, old
   * code left and new code right. Stored per browser.
   */
  readonly diffMode = signal<DiffMode>(readChoice('scr.diffMode', ['unified', 'split'] as const) ?? 'unified');
  /** How much of a method the diagrams of the flows show: name or signature. Kept per browser. */
  /** Diagrams of a data flow: the methods with their signature (else their name only). Kept per browser. */
  readonly showSignatures = signal(readChoice('scr.methodDetail', METHOD_DETAILS) === 'signature');
  /** Diagrams of a data flow: what a call gives back, as an arrow back with the type. On unless switched off. */
  readonly showReturns = signal(readText('scr.returns') !== 'false');
  readonly methodDetail = computed<MethodDetail>(() => (this.showSignatures() ? 'signature' : 'name'));
  /** path -> blame at the PR head; 'loading' while fetching, null when not available */
  readonly blames = signal<ReadonlyMap<string, Blame | 'loading' | null>>(new Map());
  /** Whole files by path (code view "Ganze Klassen" of a flow): loaded on demand; null = could not be loaded. */
  readonly wholeFiles = signal<ReadonlyMap<string, WholeFile | 'loading' | null>>(new Map());
  /** commit from the URL, applied once the commits are loaded */
  private pendingCommit: string | null = null;
  private blameErrorShown = false;

  readonly prKey = computed<PrKey | null>(() => {
    const pr = this.bundle()?.pr;
    return pr ? { provider: pr.provider, owner: pr.owner, repo: pr.repo, number: pr.number } : null;
  });

  /** The whole repository is open (number 0): every file counts as new, there are no review comments. */
  readonly isRepo = computed(() => this.bundle()?.pr.number === 0);

  /** Label, sigil (#/!) and noun of the open PR's code host. */
  readonly provider = computed(() => {
    const info = providerInfo(this.bundle()?.pr.provider);
    return this.isRepo() ? { ...info, sigil: '', noun: 'Repository' } : info;
  });

  readonly segments = computed(() => {
    const map = new Map<string, Segment>();
    for (const s of this.bundle()?.analysis.segments ?? []) {
      map.set(s.id, s);
    }
    return map;
  });

  /** PR commits by sha. */
  readonly commitBySha = computed(() => {
    const map = new Map<string, Commit>();
    for (const c of this.commits()?.commits ?? []) {
      map.set(c.sha, c);
    }
    return map;
  });

  /** Position of each PR commit, 1 = oldest. */
  readonly commitNo = computed(() => {
    const map = new Map<string, number>();
    (this.commits()?.commits ?? []).forEach((c, i) => map.set(c.sha, i + 1));
    return map;
  });

  /** "path\0key" -> sha of the commit that made the change on that line */
  readonly lineCommit = computed(() => {
    const map = new Map<string, string>();
    for (const [path, byKey] of Object.entries(this.commits()?.lines ?? {})) {
      for (const [key, sha] of Object.entries(byKey)) {
        map.set(path + SEP + key, sha);
      }
    }
    return map;
  });

  /** Number of changed lines of the PR diff per commit. */
  readonly commitLineCount = computed(() => {
    const map = new Map<string, number>();
    for (const sha of this.lineCommit().values()) {
      map.set(sha, (map.get(sha) ?? 0) + 1);
    }
    return map;
  });

  /** "path\0key" of the lines new or changed since the last review (empty unless the snapshot came from a reload). */
  readonly sinceReview = computed<ReadonlySet<string>>(() => {
    const r = this.reloadInfo();
    if (!r || r.toHeadSha !== this.bundle()?.pr.headSha) return new Set();
    const result = new Set<string>();
    for (const [path, keys] of Object.entries(r.newLines ?? {})) {
      keys.forEach((k) => result.add(path + SEP + k));
    }
    return result;
  });

  /** The views show only what is new since the last review. */
  readonly sinceReviewActive = computed(() => this.commitFilter() === SINCE_REVIEW);

  /** Reviewable lines new or changed since the last review, with their progress. */
  readonly sinceReviewProgress = computed<Progress>(() => {
    return this.progressOfLines(this.sinceReviewLines());
  });

  /** Commits that came after the last review (the head reviewed before is one of the PR's commits). */
  readonly newCommits = computed<ReadonlySet<string>>(() => {
    const from = this.sinceReview().size ? this.reloadInfo()?.fromHeadSha : null;
    const list = this.commits()?.commits ?? [];
    const i = from ? list.findIndex((c) => c.sha === from) : -1;
    return new Set(i < 0 ? [] : list.slice(i + 1).map((c) => c.sha));
  });

  /** Commit-Bezug der Tests (computed with the commits; empty until they are loaded). */
  readonly commitFindings = computed(() => this.commits()?.findings ?? []);

  /** Tests whose expectation a later commit changed: test segment id -> findings (expectation-later). */
  readonly laterExpectations = computed(() => laterExpectationsByTest(this.commitFindings()));

  /** The commit the views are filtered to, if any. */
  readonly activeCommit = computed(() => {
    const sha = this.commitFilter();
    return sha ? this.commitBySha().get(sha) ?? null : null;
  });

  /** Segments with at least one line of the selected commit; null = no commit selected. */
  private readonly commitSegments = computed<ReadonlySet<string> | null>(() => {
    const sha = this.commitFilter();
    if (!sha) return null;
    const result = new Set<string>();
    for (const s of this.bundle()?.analysis.segments ?? []) {
      if (s.lineKeys.some((k) => this.inCommit(s.path, k))) {
        result.add(s.id);
      }
    }
    return result;
  });

  /** Categories switched off by the user (global setting): hidden, and their places need no ok. */
  readonly disabledCategories = signal<ReadonlySet<string>>(new Set());

  /** Categories of the open PR that are switched on. */
  readonly categories = computed(() =>
    (this.bundle()?.analysis.categories ?? []).filter((c) => !this.disabledCategories().has(c.id)),
  );

  /** "path\0key" -> places of the line that count (= places of its segment in switched-on categories) */
  private readonly linePlaces = computed(() => {
    const map = new Map<string, string[]>();
    const off = this.disabledCategories();
    for (const s of this.bundle()?.analysis.segments ?? []) {
      const places = (s.places ?? []).filter((p) => !off.has(categoryOf(p)));
      for (const k of s.lineKeys) {
        map.set(s.path + SEP + k, places);
      }
    }
    return map;
  });

  /** Segments that only appear in switched-off categories: nothing to review there. */
  private readonly ignored = computed(() => {
    const off = this.disabledCategories();
    const result = new Set<string>();
    if (off.size === 0) return result;
    for (const s of this.bundle()?.analysis.segments ?? []) {
      if ((s.places?.length ?? 0) > 0 && s.places.every((p) => off.has(categoryOf(p)))) {
        result.add(s.id);
      }
    }
    return result;
  });

  /** All places (groups) by id, with a readable label and where to navigate. */
  readonly places = computed(() => {
    const map = new Map<string, PlaceInfo>();
    for (const c of this.bundle()?.analysis.categories ?? []) {
      for (const g of c.groups) {
        const fileGroup = c.id === 'logic' || c.id === 'tests';
        const label = g.flowId
          ? t('Flow: {name}', { name: serverText(g.label) })
          : `${serverText(c.label)} › ${fileGroup ? g.label.substring(g.label.lastIndexOf('/') + 1) : serverText(g.label)}`;
        const selection: Selection = g.flowId ? { kind: 'flow', id: g.flowId } : { kind: 'group', id: g.id };
        map.set(g.id, { id: g.id, label, categoryId: c.id, selection });
      }
    }
    return map;
  });

  /** Layer column of each segment (from the components): frontend, api, domain, ... */
  readonly areaBySegment = computed(() => {
    const map = new Map<string, string>();
    for (const c of this.bundle()?.analysis.components ?? []) {
      c.segmentIds.forEach((id) => map.set(id, c.area));
    }
    return map;
  });

  /** The types the signatures of the segments name, by id (Analysis.types; empty for older analyses). */
  readonly typesById = computed(() => new Map((this.bundle()?.analysis.types ?? []).map((t) => [t.id, t])));

  /** Component (class, module) of each segment. */
  readonly componentBySegment = computed(() => {
    const map = new Map<string, Component>();
    for (const c of this.bundle()?.analysis.components ?? []) {
      c.segmentIds.forEach((id) => map.set(id, c));
    }
    return map;
  });

  /** Test infos by test segment id. */
  readonly tests = computed(() => {
    const map = new Map<string, TestInfo>();
    for (const t of this.bundle()?.analysis.tests ?? []) {
      map.set(t.segmentId, t);
    }
    return map;
  });

  /** Coverage of the testable changed functions by segment id (static, see CodeCoverage). */
  readonly coverage = computed(() => {
    const map = new Map<string, CodeCoverage>();
    for (const c of this.bundle()?.analysis.coverage ?? []) {
      map.set(c.segmentId, c);
    }
    return map;
  });

  /** Erwartungs-Regeln that apply to changed code (empty for older analyses and a whole repository). */
  readonly ruleChecks = computed(() => this.bundle()?.analysis.ruleChecks ?? []);

  /** Mock-Grenzen: tests that mock changed code, by test id (code block badge) and by mocked segment (flow marker). */
  readonly mockWarningsByTest = computed(() => groupWarnings(this.bundle()?.analysis.mockWarnings, 'test'));
  readonly mockWarningsBySegment = computed(() => groupWarnings(this.bundle()?.analysis.mockWarnings, 'segmentId'));
  /** Wirkung von Setup und Testdaten: changed setup blocks, fixtures and helpers with the tests they affect. */
  readonly setupImpacts = computed(() => this.bundle()?.analysis.setupImpacts ?? []);
  /** The same by the changed segment (code block badge). */
  readonly setupImpactsBySegment = computed(() => {
    const map = new Map<string, SetupImpact[]>();
    for (const i of this.setupImpacts()) {
      map.set(i.segmentId, [...(map.get(i.segmentId) ?? []), i]);
    }
    return map;
  });
  /** Mock-Grenzen of each flow (what the tests really execute), by flow id. */
  readonly flowCoverage = computed(() => new Map((this.bundle()?.analysis.flowCoverage ?? []).map((c) => [c.flowId, c])));
  /** Test name by id: changed tests by segment id, existing tests by "e1" …. */
  readonly testName = computed(() => testNamer(this.bundle()?.analysis));

  /** Spec-Diff entries of tests with changed expectations or switched off, by segment id (code block badge). */
  readonly expectationsBySegment = computed(() => {
    const map = new Map<string, SpecEntry>();
    for (const f of this.bundle()?.analysis.specs ?? []) {
      for (const e of f.entries) {
        if (e.segmentId && (e.expectations?.length || e.disabled)) {
          map.set(e.segmentId, e);
        }
      }
    }
    return map;
  });

  /** The switched-on test category, which shows the coverage above its test overview; null when there is none. */
  readonly testsCategory = computed(() => this.categories().find((c) => isTestsView(c)) ?? null);

  /** The chosen connection, or null for all (also when the chosen one is gone). */
  readonly activeHost = computed(() => {
    const id = this.prHost();
    return id && (this.connections() ?? []).some((c) => c.provider === id) ? id : null;
  });

  /** Pull requests of the chosen connection (all without one). */
  readonly hostPrs = computed(() => {
    const id = this.activeHost();
    return id ? this.prs().filter((p) => p.provider === id) : this.prs();
  });

  readonly filteredPrs = computed(() => {
    const f = this.prFilter();
    return f === 'all' ? this.hostPrs() : this.hostPrs().filter((p) => p.roles.includes(f));
  });

  /** Opens the form of a connection (status bar, toolbar); null: the chosen or the first one. */
  editConnection(id: string | null): void {
    this.editedConnection.set(id);
    this.connectionsOpen.set(true);
  }

  /** Shows the pull requests of one connection only (null: of all), remembered in the browser. */
  chooseHost(id: string | null): void {
    this.prHost.set(id);
    writeChoice(PR_HOST_KEY, id);
  }

  readonly totalProgress = computed(() => this.progressOf(this.slotsFor({ kind: 'overview' })));

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  init(): void {
    this.api.me().subscribe({
      next: (me) => this.me.set(me),
      error: (e) => this.error.set(errorMessage(e)),
    });
    this.api.settings().subscribe({ next: (s) => this.disabledCategories.set(new Set(s.disabledCategories)) });
    this.loadConnections();
    this.loadPrs();
    const fromHash = parseHash(location.hash);
    if (fromHash) {
      this.open(fromHash.pr, fromHash.selection, fromHash.commit, 'replace');
    }
    window.addEventListener('focus', () => {
      this.refreshState();
      this.refreshLists(LISTS_MAX_AGE_MS);
    });
    // back and forward of the browser, and an address typed in: show what it names
    window.addEventListener('popstate', () => this.followAddress());
  }

  /** Shows what the address names, without writing the address: the pull request and view, or the start page. */
  private followAddress(): void {
    const target = parseHash(location.hash);
    if (!target) {
      if (this.bundle()) {
        this.close('none');
      }
      return;
    }
    const b = this.bundle();
    const key = this.prKey();
    if (b && key && prLabel(key) === prLabel(target.pr)) {
      this.historyMode = 'none';
      this.select(target.selection && this.isValidSelection(target.selection, b) ? target.selection : startSelection(b, this.disabledCategories()));
      this.historyMode = 'push';
    } else {
      this.open(target.pr, target.selection, target.commit, 'none');
    }
  }

  /** The lists of pull requests (mine and the pinned repositories) again; maxAgeMs: only when older than that. */
  refreshLists(maxAgeMs = 0): void {
    if (Date.now() - this.prsLoadedAt >= maxAgeMs) {
      this.loadPrs();
    }
  }

  /** Hands a search to the list of pull requests (it searches the code hosts). */
  searchFor(query: string): void {
    this.searchRequest.set({ query, seq: (this.searchRequest()?.seq ?? 0) + 1 });
  }

  loadConnections(): void {
    this.api.connections().subscribe({ next: (c) => this.connections.set(c), error: () => this.connections.set([]) });
  }

  loadTls(): void {
    this.api.tls().subscribe({ next: (s) => this.tls.set(s), error: (e) => this.error.set(errorMessage(e)) });
  }

  /** After the trusted certificates changed: connections that failed on a certificate may work now. */
  tlsChanged(settings: TlsSettings): void {
    this.tls.set(settings);
    this.connectionChanged();
  }

  /** After a connection changed: accounts, connections and the list of pull requests are fetched again. */
  connectionChanged(connections?: Connection[]): void {
    if (connections) this.connections.set(connections);
    else this.loadConnections();
    this.api.me().subscribe({ next: (me) => this.me.set(me) });
    this.loadPrs();
  }

  loadPrs(): void {
    this.prsLoadedAt = Date.now();
    this.workspace.refreshPinned();
    this.prsLoading.set(true);
    this.api.prs().subscribe({
      next: (prs) => {
        this.prs.set(prs);
        this.prsLoading.set(false);
      },
      error: (e) => {
        this.prsLoading.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  /** selection null: nothing was asked for (opened from the list or by a plain link) - the first data flow, see startSelection. */
  open(pr: PrKey, selection: Selection | null = null, commit: string | null = null, history: HistoryMode = 'push'): void {
    this.connectionsOpen.set(false);
    this.quickOpen.set(false);
    this.pendingHistory = history;
    this.pendingCommit = commit;
    this.loading.set(t('Lade {pr} …', { pr: prLabel(pr) }));
    this.error.set(null);
    this.api.bundle(pr).subscribe({
      next: (b) => this.applyBundle(b, selection),
      error: (e) => {
        this.loading.set(null);
        this.error.set(errorMessage(e));
      },
    });
  }

  /** Analyses the whole repository of the open PR (its default branch) like a pull request. */
  openRepository(): void {
    const key = this.prKey();
    if (key) {
      this.open({ ...key, number: 0 });
    }
  }

  /** Opens a PR/MR by its web URL (GitHub or GitLab, also ones not in the list). */
  openUrl(url: string): void {
    this.error.set(null);
    this.api.resolve(url.trim()).subscribe({
      next: (ref) => this.open(ref),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  reload(): void {
    const key = this.prKey();
    if (!key) {
      return;
    }
    this.loading.set(t('Lade {noun} neu von {host} …', { noun: this.provider().noun, host: this.provider().label }));
    const previousHead = this.bundle()?.pr.headSha;
    this.api.reload(key).subscribe({
      next: (b) => {
        this.applyBundle(b, this.selection());
        this.notify(reloadMessage(previousHead, b.pr.headSha, b.state.reload));
      },
      error: (e) => {
        this.loading.set(null);
        this.error.set(errorMessage(e));
      },
    });
  }

  reanalyse(): void {
    const key = this.prKey();
    if (!key) {
      return;
    }
    this.loading.set(t('Analysiere …'));
    this.api.reanalyse(key).subscribe({
      next: (b) => {
        this.applyBundle(b, this.selection());
        this.notify(t('Analyse neu berechnet'));
      },
      error: (e) => {
        this.loading.set(null);
        this.error.set(errorMessage(e));
      },
    });
  }

  /** Shows the pull request of a tab, at the view it was left at. */
  activate(tab: PrKey): void {
    const left = parseHash(this.leftAt.get(prLabel(tab)) ?? '');
    this.open({ provider: tab.provider, owner: tab.owner, repo: tab.repo, number: tab.number }, left?.selection ?? null, left?.commit ?? null);
  }

  /** Closes the tab of a pull request. Was it the one shown, the tab beside it is shown, without one the start page. */
  closeTab(pr: PrKey): void {
    const shown = this.prKey();
    const next: OpenTab | null = this.workspace.closeTab(pr);
    this.leftAt.delete(prLabel(pr));
    if (shown && prLabel(shown) === prLabel(pr)) {
      if (next) {
        this.activate(next);
      } else {
        this.close();
      }
    }
  }

  /**
   * To the start page; the tabs stay, none of them is shown. A new entry of the browser history: back returns to
   * the pull request.
   */
  close(history: HistoryMode = 'push'): void {
    if (history !== 'none' && location.hash) {
      window.history.pushState(null, '', location.pathname);
    }
    this.quickOpen.set(false);
    this.resetCommits();
    this.flowPages.set(new Map());
    this.bundle.set(null);
    this.comments.set([]);
    this.status.set(null);
    this.ok.set(new Set());
    this.okAt.set(new Map());
    // the lists show the progress of what was just reviewed
    this.refreshLists();
  }

  private applyBundle(b: ReviewBundle, selection: Selection | null): void {
    const previous = this.bundle()?.pr;
    if (!previous || prLabel(previous) !== prLabel(b.pr) || previous.headSha !== b.pr.headSha) {
      this.resetCommits(); // another PR, or new commits: blame and attribution are outdated
    }
    if (!previous || prLabel(previous) !== prLabel(b.pr)) {
      this.flowPages.set(new Map()); // the flows of another PR
      this.status.set(null);
      this.workspace.noteOpened(b.pr);
      this.workspace.openTab(b.pr);
    }
    this.bundle.set(b);
    this.applyState(b.state);
    this.loading.set(null);
    this.historyMode = this.pendingHistory;
    this.select(selection && this.isValidSelection(selection, b) ? selection : startSelection(b, this.disabledCategories()));
    this.historyMode = this.pendingHistory = 'push';
    this.loadComments();
    this.loadStatus();
    this.loadCommits();
  }

  private isValidSelection(sel: Selection, b: ReviewBundle): boolean {
    switch (sel.kind) {
      case 'overview':
        return true;
      case 'category':
        return b.analysis.categories.some((c) => c.id === sel.id);
      case 'group':
        return b.analysis.categories.some((c) => c.groups.some((g) => g.id === sel.id));
      case 'flow':
        return b.analysis.flows.some((f) => f.id === sel.id);
      case 'file':
        return b.files.some((f) => f.path === sel.path);
      case 'coverage':
        return (b.analysis.coverage?.length ?? 0) > 0;
      case 'insight':
        return INSIGHTS.some((i) => i.id === sel.id);
    }
  }

  /** Switches a category on or off (saved globally in <data>/settings.json). */
  toggleCategory(id: string): void {
    const next = new Set(this.disabledCategories());
    next.has(id) ? next.delete(id) : next.add(id);
    this.disabledCategories.set(next);
    const sel = this.selection();
    if (next.has(id) && (sel.kind === 'category' ? sel.id === id : this.currentPlace()?.startsWith(id + '/'))) {
      this.select({ kind: 'overview' });
    }
    this.api.saveSettings({ disabledCategories: [...next] }).subscribe({
      error: (e) => this.error.set(t('Einstellung nicht gespeichert: {error}', { error: errorMessage(e) })),
    });
  }

  setCollapsedAll(collapsed: boolean): void {
    this.collapseCommand.set({ collapsed, seq: (this.collapseCommand()?.seq ?? 0) + 1 });
  }

  select(selection: Selection): void {
    this.connectionsOpen.set(false);
    this.selection.set(selection);
    this.collapseCommand.set(null);
    this.updateHash();
  }

  /** Writes the view into the address. Another view is a new entry of the browser history, unless told otherwise. */
  private updateHash(mode: HistoryMode = this.historyMode): void {
    const key = this.prKey();
    if (!key || mode === 'none') {
      return;
    }
    const hash = '#' + formatHash(key, this.selection(), this.commitFilter());
    this.leftAt.set(prLabel(key), hash);
    if (location.hash === hash) {
      return;
    }
    if (mode === 'replace') {
      history.replaceState(null, '', hash);
    } else {
      history.pushState(null, '', hash);
    }
  }

  // ------------------------------------------------------------- commits & blame

  private resetCommits(): void {
    this.commits.set(null);
    this.commitFilter.set(null);
    this.blames.set(new Map());
    this.blameErrorShown = false;
    this.wholeFiles.set(new Map());
  }

  loadCommits(): void {
    const key = this.prKey();
    if (!key) return;
    this.commitsLoading.set(true);
    this.api.commits(key).subscribe({
      next: (c) => {
        this.commitsLoading.set(false);
        this.commits.set(c);
        if (c.error) {
          this.notify(t('Commits nicht verfügbar: {error}', { error: serverText(c.error) }));
        }
        const pending = this.pendingCommit;
        this.pendingCommit = null;
        const match = pending ? c.commits.find((x) => x.sha.startsWith(pending)) : null;
        if (match) {
          this.setCommitFilter(match.sha);
        } else if (pending === SINCE_REVIEW && this.sinceReview().size) {
          this.setCommitFilter(SINCE_REVIEW);
        }
      },
      error: (e) => {
        this.commitsLoading.set(false);
        this.notify(t('Commits nicht verfügbar: {error}', { error: errorMessage(e) }));
      },
    });
  }

  /** Shows only the changes of one commit (null: all). Marks then apply to that commit's lines only. */
  setCommitFilter(sha: string | null): void {
    this.commitFilter.set(sha);
    this.collapseCommand.set(null);
    // the same view, narrowed: no new entry of the browser history
    this.updateHash(this.historyMode === 'none' ? 'none' : 'replace');
  }

  /** Previous/next commit while filtering (commits without lines in the PR diff are skipped). */
  stepCommit(delta: number): void {
    const list = (this.commits()?.commits ?? []).filter((c) => (this.commitLineCount().get(c.sha) ?? 0) > 0);
    const i = list.findIndex((c) => c.sha === this.commitFilter());
    const next = list[i < 0 ? (delta > 0 ? 0 : list.length - 1) : i + delta];
    if (next) {
      this.setCommitFilter(next.sha);
    }
  }

  /** Changed lines of the PR diff made by a commit, everywhere (place null). */
  commitLines(sha: string): LineMark[] {
    const lc = this.lineCommit();
    const ignored = this.ignored();
    const result: LineMark[] = [];
    for (const s of this.bundle()?.analysis.segments ?? []) {
      if (ignored.has(s.id)) continue;
      for (const key of s.lineKeys) {
        if (lc.get(s.path + SEP + key) === sha) {
          result.push({ path: s.path, key, place: null });
        }
      }
    }
    return result;
  }

  /** Review progress of a commit's lines (a line counts when it is ok at all its places). */
  commitProgress(sha: string): Progress {
    return this.progressOfLines(this.commitLines(sha));
  }

  /** Progress of lines counted without a place: a line counts when it is ok at all its places. */
  private progressOfLines(lines: LineMark[]): Progress {
    const ok = lines.filter((l) => this.isOkAt(l.path, l.key, null)).length;
    return { ok, total: lines.length, all: ok, multi: 0 };
  }

  /** sha of the commit that made the change on a line of the PR diff, if known */
  commitOfLine(path: string, key: string): string | undefined {
    return this.lineCommit().get(path + SEP + key);
  }

  /** Is the change on this line part of the selected commit (or new since the review)? Always true without a filter. */
  inCommit(path: string, key: string): boolean {
    const sha = this.commitFilter();
    if (sha === SINCE_REVIEW) {
      return this.sinceReview().has(path + SEP + key);
    }
    return !sha || this.lineCommit().get(path + SEP + key) === sha;
  }

  /** Reviewable lines new or changed since the last review, everywhere (place null). */
  sinceReviewLines(): LineMark[] {
    const since = this.sinceReview();
    if (!since.size) return [];
    const ignored = this.ignored();
    const result: LineMark[] = [];
    for (const s of this.bundle()?.analysis.segments ?? []) {
      if (ignored.has(s.id)) continue;
      for (const key of s.lineKeys) {
        if (since.has(s.path + SEP + key)) {
          result.push({ path: s.path, key, place: null });
        }
      }
    }
    return result;
  }

  toggleAnnotate(): void {
    const on = !this.annotate();
    this.annotate.set(on);
    writeFlag('scr.annotate', on);
  }

  toggleTestInfo(): void {
    const on = !this.testInfo();
    this.testInfo.set(on);
    writeFlag('scr.testInfo', on);
  }

  setShowSignatures(on: boolean): void {
    this.showSignatures.set(on);
    writeChoice('scr.methodDetail', on ? 'signature' : 'name');
  }

  setShowReturns(on: boolean): void {
    this.showReturns.set(on);
    writeFlag('scr.returns', on);
  }

  setDiffMode(mode: DiffMode): void {
    this.diffMode.set(mode);
    writeChoice('scr.diffMode', mode);
  }

  /** The settings of the page of a flow (the defaults until the user changes one there). */
  flowPage(flowId: string): FlowPage {
    return this.flowPages().get(flowId) ?? FLOW_PAGE_DEFAULT;
  }

  /** Changes settings of the page of one flow; the pages of the other flows keep theirs. */
  setFlowPage(flowId: string, change: Partial<FlowPage>): void {
    this.flowPages.set(new Map(this.flowPages()).set(flowId, { ...this.flowPage(flowId), ...change }));
  }

  /** Fetches the blame of a file once (cached by the backend per head commit). */
  ensureBlame(path: string): void {
    const key = this.prKey();
    if (!key || this.blames().has(path)) return;
    const put = (value: Blame | 'loading' | null) => this.blames.set(new Map(this.blames()).set(path, value));
    put('loading');
    this.api.blame(key, path).subscribe({
      next: (b) => put(b),
      error: (e) => {
        put(null);
        if (!this.blameErrorShown) {
          this.blameErrorShown = true;
          this.notify(t('Blame nicht verfügbar: {error}', { error: errorMessage(e) }));
        }
      },
    });
  }

  /** Loads a changed file as a whole (once per PR snapshot). */
  ensureWholeFile(path: string): void {
    const key = this.prKey();
    if (!key || this.wholeFiles().has(path)) return;
    const put = (value: WholeFile | 'loading' | null) => this.wholeFiles.set(new Map(this.wholeFiles()).set(path, value));
    put('loading');
    this.api.wholeFile(key, path).subscribe({ next: (f) => put(f), error: () => put(null) });
  }

  /** Shows the coverage of the changed code: in the test category if switched on, else on its own page. */
  openCoverage(): void {
    const tests = this.testsCategory();
    this.select(tests ? { kind: 'category', id: tests.id } : { kind: 'coverage' });
  }

  /** Navigates to a segment at another place than the current one (its first place, else its file). */
  reveal(segmentId: string): void {
    const seg = this.segments().get(segmentId);
    if (!seg) {
      return;
    }
    const current = this.currentPlace();
    const on = seg.places.filter((p) => !this.disabledCategories().has(categoryOf(p)));
    const place = on.find((p) => p !== current) ?? on[0];
    if (place) {
      this.goToPlace(place, segmentId);
    } else {
      this.focusSegment.set(segmentId);
      this.select({ kind: 'file', path: seg.path });
    }
  }

  /** Like reveal, and then scrolls to a line of the block (when the block is expanded). */
  revealLine(segmentId: string, line: number): void {
    this.focusLine.set({ segmentId, line });
    this.reveal(segmentId);
  }

  /** The line to show in a block that was just scrolled to (once), else null. */
  takeFocusLine(segmentId: string): number | null {
    const f = this.focusLine();
    if (!f || f.segmentId !== segmentId) {
      return null;
    }
    this.focusLine.set(null);
    return f.line;
  }

  goToPlace(place: string, segmentId: string): void {
    const info = this.places().get(place);
    if (info) {
      this.focusSegment.set(segmentId);
      this.select(info.selection);
    }
  }

  /** The place (group id) the editor currently shows, if it shows exactly one group or flow. */
  currentPlace(): string | null {
    const sel = this.selection();
    if (sel.kind === 'group') return sel.id;
    if (sel.kind === 'flow') return 'flows/' + sel.id;
    return null;
  }

  /** The segments a selection shows, each at the place it is shown at (only those of the selected commit). */
  slotsFor(sel: Selection): Slot[] {
    const slots = this.allSlotsFor(sel);
    const only = this.commitSegments();
    return only ? slots.filter((s) => only.has(s.segmentId)) : slots;
  }

  /** Does the segment change anything in the selected commit (always true without a commit filter)? */
  inCommitSegment(segmentId: string): boolean {
    return this.commitSegments()?.has(segmentId) ?? true;
  }

  private allSlotsFor(sel: Selection): Slot[] {
    const b = this.bundle();
    if (!b) return [];
    const cats = b.analysis.categories;
    const groupSlots = (groups: { id: string; segmentIds: string[] }[]) =>
      groups.flatMap((g) => g.segmentIds.map((segmentId) => ({ segmentId, place: g.id })));
    switch (sel.kind) {
      case 'overview':
        return b.analysis.segments.map((s) => ({ segmentId: s.id, place: null }));
      case 'category':
        return groupSlots(cats.find((c) => c.id === sel.id)?.groups ?? []);
      case 'group':
        return groupSlots(cats.flatMap((c) => c.groups).filter((g) => g.id === sel.id));
      case 'flow':
        return groupSlots(cats.flatMap((c) => c.groups).filter((g) => g.flowId === sel.id));
      case 'file':
        return b.analysis.segments
          .filter((s) => s.path === sel.path)
          .sort((x, y) => (x.startLine ?? lineOf(x.lineKeys[0])) - (y.startLine ?? lineOf(y.lineKeys[0])))
          .map((s) => ({ segmentId: s.id, place: null }));
      case 'coverage':
      case 'insight':
        return [];
    }
  }

  // ------------------------------------------------------------- marks

  /** The stored accept state of a line ("path\0key"). */
  private acceptanceOf(k: string, places: readonly string[]): Acceptance {
    return { full: this.ok().has(k), at: new Set(places.filter((p) => this.okAt().get(p)?.has(k))) };
  }

  /**
   * Status of the line at this place: accepted, 'partial' (= half accepted: accepted at another place, not here)
   * or open. place null: overall - accepted when accepted at all its places.
   */
  lineStatus(path: string, key: string, place: string | null): AcceptStatus {
    const k = path + SEP + key;
    return statusOf(this.acceptanceOf(k, this.linePlaces().get(k) ?? []), this.linePlaces().get(k) ?? [], place);
  }

  /** Is the line ok at this place? place null: ok at all its places. */
  isOkAt(path: string, key: string, place: string | null): boolean {
    return this.lineStatus(path, key, place) === 'accepted';
  }

  /** The boxes of a line as seen from a place: one per place the line is shown at (switched-off categories do not count). */
  lineBoxes(path: string, key: string, place: string | null): LineBoxes {
    const k = path + SEP + key;
    const places = this.linePlaces().get(k) ?? [];
    return lineBoxes(this.acceptanceOf(k, places), places, place);
  }

  /** Lines of the slots; every slot (segment at a place) counts on its own. */
  progressOf(slots: Iterable<Slot>): Progress {
    const segs = this.segments();
    let total = 0;
    let done = 0;
    let all = 0;
    let multi = 0;
    const linePlaces = this.linePlaces();
    const seen = new Set<string>();
    const ignored = this.ignored();
    for (const slot of slots) {
      const id = slot.segmentId + SEP + slot.place;
      const s = segs.get(slot.segmentId);
      if (seen.has(id) || !s || (slot.place == null && ignored.has(s.id))) {
        continue;
      }
      seen.add(id);
      for (const k of s.lineKeys) {
        if (!this.inCommit(s.path, k)) {
          continue;
        }
        total++;
        const line = s.path + SEP + k;
        const places = linePlaces.get(line) ?? [];
        const acceptance = this.acceptanceOf(line, places);
        if (statusOf(acceptance, places, slot.place) === 'accepted') {
          done++;
        }
        if (statusOf(acceptance, places, null) === 'accepted') {
          all++;
        }
        if (places.length > 1) {
          multi++;
        }
      }
    }
    return { ok: done, total, all, multi };
  }

  linesOf(slots: Iterable<Slot>): LineMark[] {
    const segs = this.segments();
    const result: LineMark[] = [];
    const seen = new Set<string>();
    for (const slot of slots) {
      const s = segs.get(slot.segmentId);
      if (!s || seen.has(slot.segmentId + SEP + slot.place)) {
        continue;
      }
      seen.add(slot.segmentId + SEP + slot.place);
      for (const key of s.lineKeys) {
        if (this.inCommit(s.path, key)) {
          result.push({ path: s.path, key, place: slot.place });
        }
      }
    }
    return result;
  }

  /** Marks the lines as ok, or - if all of them already are - removes the mark (toggle). */
  toggle(lines: LineMark[], scope: string): void {
    const allOk = lines.length > 0 && lines.every((l) => this.isOkAt(l.path, l.key, l.place));
    this.mark(lines, !allOk, scope);
  }

  /**
   * "Ok everywhere": accepts the lines at all their places (ok), or takes that step back: the accept at the other
   * places goes, the place of the mark stays as it is. A mark without a place is taken back at all places.
   */
  markEverywhere(lines: LineMark[], ok: boolean, scope: string): void {
    if (ok) {
      this.mark(lines.map((l) => ({ ...l, place: null })), true, scope);
      return;
    }
    const linePlaces = this.linePlaces();
    this.mark(lines.flatMap((l) => everywhereTargets(linePlaces.get(l.path + SEP + l.key) ?? [], l.place, false)
      .map((place): LineMark => ({ ...l, place }))), false, scope);
  }

  /** Accepts the lines everywhere, or - if all of them already are - takes that back (see markEverywhere). */
  toggleEverywhere(lines: LineMark[], scope: string): void {
    const allOk = lines.length > 0 && lines.every((l) => this.isOkAt(l.path, l.key, null));
    this.markEverywhere(lines, !allOk, scope);
  }

  /** Optimistic version of the backend logic (ReviewService.mark): one ok per place, then "ok everywhere". */
  mark(lines: LineMark[], ok: boolean, scope: string): void {
    const key = this.prKey();
    if (!key || lines.length === 0) {
      return;
    }
    const full = new Set(this.ok());
    const at = new Map([...this.okAt()].map(([p, set]) => [p, new Set(set)]));
    const atSet = (p: string) => at.get(p) ?? at.set(p, new Set()).get(p)!;
    for (const l of lines) {
      const k = l.path + SEP + l.key;
      const places = this.linePlaces().get(k) ?? [];
      const next = accept({ full: full.has(k), at: new Set(places.filter((p) => at.get(p)?.has(k))) }, places, l.place, ok);
      full.delete(k);
      places.forEach((p) => at.get(p)?.delete(k));
      if (next.full) {
        full.add(k);
      }
      next.at.forEach((p) => atSet(p).add(k));
    }
    this.ok.set(full);
    this.okAt.set(at);
    this.api.mark(key, lines, ok, scope).subscribe({
      next: (state) => this.applyState(state),
      error: (e) => {
        this.error.set(t('Markierung nicht gespeichert: {error}', { error: errorMessage(e) }));
        this.refreshState();
      },
    });
  }

  /** Picks up changes made outside the UI (e.g. by an agent editing review.json). */
  refreshState(): void {
    const key = this.prKey();
    if (key) {
      this.api.state(key).subscribe({ next: (s) => this.applyState(s) });
    }
  }

  private applyState(state: ReviewState): void {
    const set = new Set<string>();
    for (const [path, keys] of Object.entries(state.ok ?? {})) {
      for (const k of keys) {
        set.add(path + SEP + k);
      }
    }
    const at = new Map<string, Set<string>>();
    for (const [place, byPath] of Object.entries(state.okAt ?? {})) {
      const keys = new Set<string>();
      for (const [path, list] of Object.entries(byPath)) {
        list.forEach((k) => keys.add(path + SEP + k));
      }
      at.set(place, keys);
    }
    this.ok.set(set);
    this.okAt.set(at);
    this.log.set(state.log ?? []);
    this.reloadInfo.set(state.reload ?? null);
  }

  // ------------------------------------------------------------- comments

  loadComments(): void {
    const key = this.prKey();
    if (key) {
      this.api.comments(key).subscribe({ next: (c) => this.comments.set(c) });
    }
  }

  postComment(comment: NewComment, done: (ok: boolean) => void): void {
    const key = this.prKey();
    if (!key) {
      return;
    }
    this.api.postComment(key, comment).subscribe({
      next: (c) => {
        this.comments.set([...this.comments(), c]);
        this.notify(t('Kommentar auf {host} veröffentlicht', { host: this.provider().label }));
        done(true);
      },
      error: (e) => {
        this.error.set(t('Kommentar fehlgeschlagen: {error}', { error: errorMessage(e) }));
        done(false);
      },
    });
  }

  // ------------------------------------------------------------- approve & merge

  /** Reads where the PR stands on the code host; quietly nothing when the host cannot say. */
  loadStatus(): void {
    const key = this.prKey();
    if (!key || key.number === 0) {
      this.status.set(null);
      return;
    }
    this.api.status(key).subscribe({
      next: (s) => this.samePr(key) && this.status.set(s ?? null),
      error: () => this.samePr(key) && this.status.set(null),
    });
  }

  private samePr(key: PrKey): boolean {
    const now = this.prKey();
    return !!now && prLabel(now) === prLabel(key);
  }

  /** Approves the PR on the code host, or revokes the approval. */
  approve(approved: boolean, done: (ok: boolean) => void): void {
    const key = this.prKey();
    if (!key) {
      return done(false);
    }
    this.api.approve(key, approved).subscribe({
      next: (s) => {
        this.status.set(s);
        this.notify(approved ? t('Genehmigt') : t('Genehmigung zurückgezogen'));
        done(true);
      },
      error: (e) => {
        this.error.set(t('Genehmigen fehlgeschlagen: {error}', { error: errorMessage(e) }));
        this.loadStatus();
        done(false);
      },
    });
  }

  /** Merges the PR on the code host. */
  merge(options: MergeOptions, done: (ok: boolean) => void): void {
    const key = this.prKey();
    if (!key) {
      return done(false);
    }
    this.api.merge(key, options).subscribe({
      next: (s) => {
        this.status.set(s);
        this.notify(t('Gemergt'));
        this.loadPrs();
        done(true);
      },
      error: (e) => {
        this.error.set(t('Mergen fehlgeschlagen: {error}', { error: errorMessage(e) }));
        this.loadStatus();
        done(false);
      },
    });
  }

  /** Resolves a thread of comments on the code host or opens it again. */
  resolveThread(thread: string, resolved: boolean, done: (ok: boolean) => void): void {
    const key = this.prKey();
    if (!key) {
      return done(false);
    }
    this.api.resolveThread(key, thread, resolved).subscribe({
      next: (comments) => {
        this.comments.set(comments);
        this.loadStatus(); // open threads can block the merge
        this.notify(resolved ? t('Thread aufgelöst') : t('Thread wieder geöffnet'));
        done(true);
      },
      error: (e) => {
        this.error.set(t('Thread nicht geändert: {error}', { error: errorMessage(e) }));
        done(false);
      },
    });
  }

  notify(message: string): void {
    this.toast.set(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 2600);
  }
}

function categoryOf(place: string): string {
  const slash = place.indexOf('/');
  return slash < 0 ? place : place.substring(0, slash);
}

function lineOf(key: string | undefined): number {
  return key ? Number(key.substring(1)) : 0;
}

const PR_HOST_KEY = 'scr.prHost';
/** Coming back to the window, the lists of pull requests are fetched again when they are older than this. */
const LISTS_MAX_AGE_MS = 2 * 60 * 1000;

/** How a change of the address is written to the browser history. */
type HistoryMode = 'push' | 'replace' | 'none';

function readText(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function readFlag(name: string): boolean {
  try {
    return localStorage.getItem(name) === 'true';
  } catch {
    return false;
  }
}

function writeFlag(name: string, on: boolean): void {
  writeChoice(name, String(on));
}

/** A stored choice out of a fixed set; null when nothing (valid) is stored. */
function readChoice<T extends string>(name: string, allowed: readonly T[]): T | null {
  try {
    const value = localStorage.getItem(name);
    return allowed.find((a) => a === value) ?? null;
  } catch {
    return null;
  }
}

function writeChoice(name: string, value: string | null): void {
  try {
    if (value == null) {
      localStorage.removeItem(name);
    } else {
      localStorage.setItem(name, value);
    }
  } catch {
    // storage unavailable - the setting is just not remembered
  }
}

// ------------------------------------------------------------- hash routing: #/github/owner/repo/12[/c/<sha>]/flow/flow-1

export function formatHash(pr: PrKey, sel: Selection, commit: string | null): string {
  const base = `/${pr.provider}/${pr.owner}/${pr.repo}/${pr.number}` + (commit ? `/c/${commit.substring(0, 12)}` : '');
  switch (sel.kind) {
    case 'file':
      return `${base}/file/${encodeURIComponent(sel.path)}`;
    case 'overview':
      return `${base}/overview`;
    case 'coverage':
      return `${base}/coverage`;
    case 'insight':
      return `${base}/view/${encodeURIComponent(sel.id)}`;
    default:
      return `${base}/${sel.kind}/${encodeURIComponent(sel.id)}`;
  }
}

/** selection null: the link names only the pull request (see startSelection). */
export function parseHash(hash: string): { pr: PrKey; selection: Selection | null; commit: string | null } | null {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts.length < 4 || !/^\d+$/.test(parts[3])) {
    return null;
  }
  const pr = { provider: parts[0], owner: parts[1], repo: parts[2], number: Number(parts[3]) };
  let commit: string | null = null;
  if (parts[4] === 'c' && (/^[0-9a-f]{4,40}$/i.test(parts[5] ?? '') || parts[5] === SINCE_REVIEW)) {
    commit = parts[5].toLowerCase();
    parts.splice(4, 2);
  }
  const kind = parts[4];
  const value = parts[5] ? decodeURIComponent(parts[5]) : '';
  let selection: Selection | null = null;
  if (kind === 'file' && value) {
    selection = { kind: 'file', path: value };
  } else if (kind === 'overview') {
    selection = { kind: 'overview' };
  } else if (kind === 'coverage') {
    selection = { kind: 'coverage' };
  } else if (kind === 'view' && value) {
    selection = { kind: 'insight', id: value };
  } else if ((kind === 'category' || kind === 'group' || kind === 'flow') && value) {
    selection = { kind, id: value };
  }
  return { pr, selection, commit };
}
