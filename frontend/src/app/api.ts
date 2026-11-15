import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

// Mirrors backend dev.smartcodereview.model.Model

export interface User {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface Account {
  provider: string;
  label: string;
  host: string;
  user: User | null;
  error: string | null;
}

export interface Me {
  accounts: Account[];
  dataDir: string;
  /** running release, e.g. "0.3.0" */
  version: string;
}

export interface ProviderInfo {
  label: string;
  /** "#12" on GitHub, "!12" on GitLab */
  sigil: string;
  noun: string;
}

const PROVIDERS: Record<string, ProviderInfo> = {
  github: { label: 'GitHub', sigil: '#', noun: 'Pull Request' },
  gitlab: { label: 'GitLab', sigil: '!', noun: 'Merge Request' },
};

export function providerInfo(provider: string | null | undefined): ProviderInfo {
  return PROVIDERS[provider ?? ''] ?? { label: provider ?? '?', sigil: '#', noun: 'Pull Request' };
}

/** Nested GitLab groups travel as "group~sub" in refs and URLs; show them with slashes. */
export function ownerLabel(owner: string): string {
  return owner.replaceAll('~', '/');
}

/** e.g. "cyrilleulmi/spongecoach#13" or "gitlab-org/cli!4347"; number 0 = the whole repository */
export function prLabel(pr: { provider: string; owner: string; repo: string; number: number }): string {
  const repo = `${ownerLabel(pr.owner)}/${pr.repo}`;
  return pr.number === 0 ? `${repo} (Repository)` : `${repo}${providerInfo(pr.provider).sigil}${pr.number}`;
}

export type PrRole = 'authored' | 'review-requested';

export interface PullRequestSummary {
  provider: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  roles: PrRole[];
  progress: { ok: number; total: number } | null;
}

export interface PullRequestInfo {
  provider: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  draft: boolean;
  state: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  startSha: string | null;
}

/** A commit (Model.Commit). additions/deletions/files: vs. its first parent (0/empty in blame results). */
export interface Commit {
  sha: string;
  title: string;
  message: string;
  author: string | null;
  authorLogin: string | null;
  avatarUrl: string | null;
  date: string | null;
  url: string | null;
  parents: string[];
  additions: number;
  deletions: number;
  files: string[];
}

/** commits.json: the PR's commits (oldest first) and which commit made each changed line. */
export interface Commits {
  version: number;
  headSha: string;
  generatedAt: string;
  commits: Commit[];
  /** path -> line key -> sha */
  lines: Record<string, Record<string, string>>;
  /** commit of a merged side branch -> merge commit its changes are attributed to */
  mergedVia: Record<string, string>;
  error: string | null;
}

export interface BlameRange {
  start: number;
  end: number;
  sha: string;
}

/** git blame of a file at the PR head */
export interface Blame {
  path: string;
  sha: string;
  ranges: BlameRange[];
  commits: Commit[];
}

export interface LineRef {
  segmentId: string;
  symbol: string;
}

export interface DisplayLine {
  type: 'add' | 'del' | 'ctx' | 'gap';
  oldLine: number | null;
  newLine: number | null;
  key: string | null;
  text: string | null;
  own: boolean;
  inDiff: boolean;
  gapSize: number | null;
  refs: LineRef[] | null;
}

export interface Segment {
  id: string;
  path: string;
  language: string;
  kind: 'hunk' | 'symbol' | 'module';
  symbol: string | null;
  symbolKind: string | null;
  startLine: number | null;
  endLine: number | null;
  category: string;
  group: string;
  ruleId: string | null;
  reason: string;
  lineKeys: string[];
  lines: DisplayLine[];
  /** ids of all groups showing this segment ("quick-wins/mapper", "flows/flow-2", ...); each needs its own ok */
  places: string[];
  /** test segments that reach this code */
  testedBy: string[];
  /** ports & adapters layer (domain | application | usecase | adapter), null if none */
  layer: string | null;
  frontend: boolean;
}

export interface Group {
  id: string;
  label: string;
  description: string | null;
  flowId: string | null;
  segmentIds: string[];
}

/** Categories with their own UI (data flows) say so in `view`; older analyses only have the id to go by. */
export function isFlowView(c: { id: string; view?: string | null }): boolean {
  return (c.view ?? (c.id === 'flows' ? 'flow' : 'groups')) === 'flow';
}

/** The test category: groups plus the test overview and the coverage of the changed code. */
export function isTestsView(c: { view?: string | null }): boolean {
  return c.view === 'tests';
}

export interface Category {
  id: string;
  label: string;
  /** what the category is for */
  description: string;
  icon: string;
  groups: Group[];
  /** how the category is composed / split into groups (absent in analyses of older versions) */
  builds?: string | null;
  divides?: string | null;
  /** 'groups' = list of groups; other values are exceptions with their own UI ('flow', 'tests') */
  view?: string | null;
  /** 'builtin' | 'rules' (| later 'external') */
  origin?: string | null;
}

export interface FlowStep {
  segmentId: string;
  order: number;
  depth: number;
  parentSegmentId: string | null;
}

export interface FlowEdge {
  from: string;
  to: string;
  line: number | null;
  via: string;
  /** "http" = frontend REST call matched to a backend endpoint (via = "PUT /api/x/{}") */
  kind: 'call' | 'http';
}

export interface Flow {
  id: string;
  title: string;
  steps: FlowStep[];
  edges: FlowEdge[];
}

export interface TestSubject {
  name: string;
  path: string | null;
  inPr: boolean;
  how: 'name' | 'call';
}

export interface TestCoverage {
  segmentId: string;
  direct: boolean;
  via: string | null;
  line: number | null;
}

export interface TestInfo {
  segmentId: string;
  name: string;
  path: string;
  subjects: TestSubject[];
  covers: TestCoverage[];
  /** Test-Steckbrief; null in analyses of older versions */
  profile: TestProfile | null;
}

export type TestScenario = 'error' | 'edge' | 'normal';
export type TestLevel = 'unit' | 'integration' | 'e2e';
export type AssertionKind = 'equality' | 'exception' | 'interaction' | 'existence' | 'http' | 'snapshot' | 'other';

/**
 * Test-Steckbrief (Model.TestProfile): what a test checks, in one line - pattern-based (rules section
 * "testProfile"), deterministic.
 */
export interface TestProfile {
  /** changed code the test calls directly (symbol names), else the unit from the test file name */
  targets: string[];
  /** error = expects a failure, edge = empty/null/limit inputs, normal = everything else */
  scenario: TestScenario;
  /** where the scenario pattern matched (null for normal) */
  scenarioBy: 'code' | 'name' | null;
  /** the matched text */
  scenarioReason: string | null;
  /** assertion statements in the test body */
  assertions: number;
  /** count per kind, only kinds that occur */
  assertionKinds: Partial<Record<AssertionKind, number>>;
  /** collaborators replaced in the test or its surroundings ("HTTP" = mocked backend) */
  mocks: string[];
  level: TestLevel;
  /** null for unit */
  levelBy: 'path' | 'code' | null;
  /** the matched glob or code */
  levelReason: string | null;
  /** runs once per row of a table (@ParameterizedTest, it.each, Go table test) */
  parameterized: boolean;
  /** rows when the table is literal, else null */
  cases: number | null;
  /** @CsvSource, @ValueSource, it.each, table, ... */
  casesSource: string | null;
}

export type CoverageStatus = 'direct' | 'indirect' | 'none';

/**
 * Coverage of a testable changed function, seen from the code (Model.CodeCoverage), found statically:
 * direct = a changed test calls it, indirect = only reached via other changed code, none = no changed test reaches it.
 */
export interface CodeCoverage {
  segmentId: string;
  status: CoverageStatus;
  directTests: string[];
  indirectTests: string[];
  /** decision points in the whole function (if, case, catch, for, while, &&, ||, ternary) */
  branches: number;
  /** non-blank, non-brace changed lines */
  changedLines: number;
  /** changedLines × (1 + branches), for sorting */
  risk: number;
}

export type SpecStatus = 'added' | 'removed' | 'changed' | 'renamed' | 'unchanged';

/** One suite or test of a changed test file in the Spec-Diff outline (Model.SpecEntry). */
export interface SpecEntry {
  name: string;
  /** enclosing suites, outermost first (JUnit: test class and @Nested classes) */
  suites: string[];
  kind: 'suite' | 'test';
  status: SpecStatus;
  /** renamed: the old name (old suite path joined with " › " when the suites differ too) */
  previousName: string | null;
  /** segment with this suite/test when it has changed lines; null for removed and untouched entries */
  segmentId: string | null;
  /** start line in the new file / in the base version */
  line: number | null;
  oldLine: number | null;
  /** indentation in the outline */
  depth: number;
  /** changed expectations against the base version (absent in older analyses) */
  expectations?: ExpectationChange[] | null;
  /** assertion statements in the test body, base / new version (null for suites and missing sides) */
  assertionsBefore?: number | null;
  assertionsAfter?: number | null;
  /** switched off now (itself or an enclosing suite: xit, it.skip, @Disabled, t.Skip …) */
  disabled?: boolean;
}

export type ExpectationKind = 'changed' | 'weakened' | 'removed' | 'added' | 'disabled' | 'enabled';

/**
 * A changed expectation in a test (Model.ExpectationChange), pattern-based: changed = same subject, other expected
 * value or matcher; weakened = to a matcher that only checks existence/truthiness; disabled/enabled = the test or an
 * enclosing suite was switched off/on. Texts: the assertion statement (or the switching line); null where that side
 * does not exist.
 */
export interface ExpectationChange {
  kind: ExpectationKind;
  oldText: string | null;
  newText: string | null;
  oldLine: number | null;
  newLine: number | null;
}

/** The test names of a changed test file, old against new version (Model.SpecFile). */
export interface SpecFile {
  path: string;
  previousPath: string | null;
  status: string;
  /** false: the base version could not be loaded, only the new side is shown */
  baseAvailable: boolean;
  /** new file order, removed entries at their old place */
  entries: SpecEntry[];
}

export interface ArchitectureInfo {
  /** hexagonal: ports & adapters; layered: domain / application / adapter packages without ports */
  style: 'hexagonal' | 'layered' | null;
  evidence: string[];
}

export interface Component {
  id: string;
  name: string;
  paths: string[];
  /** column in the component diagram */
  area: string;
  segmentIds: string[];
}

export interface ComponentEdge {
  from: string;
  to: string;
  calls: number;
  http: boolean;
}

export interface Settings {
  disabledCategories: string[];
}

export interface Analysis {
  schemaVersion: number;
  generatedAt: string;
  headSha: string;
  rulesHash: string;
  segments: Segment[];
  categories: Category[];
  flows: Flow[];
  tests: TestInfo[];
  architecture: ArchitectureInfo | null;
  components: Component[];
  componentEdges: ComponentEdge[];
  /** testable changed functions: none first, then indirect, then direct, each by risk (absent in older analyses) */
  coverage?: CodeCoverage[] | null;
  /** Spec-Diff: test names of every changed test file, in path order (absent in older analyses) */
  specs?: SpecFile[] | null;
  /** Fallmatrix: similar and parameterised tests as tables input → expected, by path and line (absent in older analyses) */
  caseMatrices?: CaseMatrix[] | null;
}

export type CaseMatrixKind = 'similar' | 'parameterized';
export type CaseColumnRole = 'input' | 'expected';

/**
 * Fallmatrix (Model.CaseMatrix): near-identical tests of a changed test file, or the rows of one parameterised test,
 * as a table input → expected - pattern-based, deterministic. template: the code of the first row with the columns as
 * slots ‹1›, ‹2›, … (slot n = columns[n-1]); columns: input columns first, then expected ones.
 */
export interface CaseMatrix {
  id: string;
  path: string;
  title: string;
  kind: CaseMatrixKind;
  template: string;
  columns: CaseColumn[];
  rows: CaseRow[];
}

export interface CaseColumn {
  /** where the value goes (`putJerseyNumber(…) Arg 1`, a parameter name) or what is checked (`statusCode`) */
  label: string;
  role: CaseColumnRole;
  /** input columns: the distinct values of all rows, sorted - what is covered; empty for expected columns */
  values: string[];
}

export interface CaseRow {
  /** test name (parameterised: the display name of the case) */
  name: string;
  /** the test's segment when it has changed lines, null for unchanged tests of the file */
  segmentId: string | null;
  line: number | null;
  /** one per column, as written (strings with quotes); null = not checked by this test, «✓» = checked without a value */
  values: (string | null)[];
  /** index of an earlier row with the same inputs (same case tested twice) */
  duplicateOf: number | null;
  /** such a duplicate expects something else */
  contradicts: boolean;
}

export interface LogEntry {
  at: string;
  by: string;
  action: string;
  scope: string;
  count: number;
}

export interface ReviewState {
  schemaVersion: number;
  pr: string;
  headSha: string | null;
  ok: Record<string, string[]>;
  log: LogEntry[];
  /** place -> path -> keys that are ok at that place only */
  okAt: Record<string, Record<string, string[]>>;
}

export interface FileSummary {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  language: string;
}

export interface ReviewBundle {
  pr: PullRequestInfo;
  fetchedAt: string;
  dataPath: string;
  files: FileSummary[];
  analysis: Analysis;
  state: ReviewState;
}

export interface Comment {
  id: number;
  kind: 'review' | 'issue';
  path: string | null;
  line: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  key: string | null;
  body: string;
  author: string;
  avatarUrl: string | null;
  createdAt: string;
  url: string;
  inReplyTo: number | null;
}

export interface NewComment {
  path?: string | null;
  line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  body: string;
  inReplyTo?: number | null;
  /** both set for context lines (GitLab needs both to anchor a comment) */
  oldLine?: number | null;
  newLine?: number | null;
}

export interface LineMark {
  path: string;
  key: string;
  /** group id the mark applies to; null = all places of the line */
  place: string | null;
}

export interface PrKey {
  provider: string;
  owner: string;
  repo: string;
  number: number;
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  me(): Observable<Me> {
    return this.http.get<Me>('/api/me');
  }

  settings(): Observable<Settings> {
    return this.http.get<Settings>('/api/settings');
  }

  saveSettings(settings: Settings): Observable<Settings> {
    return this.http.put<Settings>('/api/settings', settings);
  }

  prs(): Observable<PullRequestSummary[]> {
    return this.http.get<PullRequestSummary[]>('/api/prs');
  }

  resolve(url: string): Observable<PrKey> {
    return this.http.get<PrKey>('/api/resolve', { params: { url } });
  }

  bundle(pr: PrKey): Observable<ReviewBundle> {
    return this.http.get<ReviewBundle>(base(pr));
  }

  reload(pr: PrKey): Observable<ReviewBundle> {
    return this.http.post<ReviewBundle>(`${base(pr)}/reload`, null);
  }

  reanalyse(pr: PrKey): Observable<ReviewBundle> {
    return this.http.post<ReviewBundle>(`${base(pr)}/reanalyse`, null);
  }

  state(pr: PrKey): Observable<ReviewState> {
    return this.http.get<ReviewState>(`${base(pr)}/state`);
  }

  mark(pr: PrKey, lines: LineMark[], ok: boolean, scope: string): Observable<ReviewState> {
    return this.http.post<ReviewState>(`${base(pr)}/marks`, { lines, ok, scope, by: 'ui' });
  }

  comments(pr: PrKey): Observable<Comment[]> {
    return this.http.get<Comment[]>(`${base(pr)}/comments`);
  }

  commits(pr: PrKey): Observable<Commits> {
    return this.http.get<Commits>(`${base(pr)}/commits`);
  }

  blame(pr: PrKey, path: string): Observable<Blame> {
    return this.http.get<Blame>(`${base(pr)}/blame`, { params: { path } });
  }

  postComment(pr: PrKey, comment: NewComment): Observable<Comment> {
    return this.http.post<Comment>(`${base(pr)}/comments`, comment);
  }
}

function base(pr: PrKey): string {
  return `/api/prs/${pr.provider}/${pr.owner}/${pr.repo}/${pr.number}`;
}

export function errorMessage(err: unknown): string {
  const e = err as { error?: { message?: string }; message?: string; status?: number };
  return e?.error?.message ?? (e?.status === 0 ? 'Backend nicht erreichbar' : e?.message ?? 'Unbekannter Fehler');
}
