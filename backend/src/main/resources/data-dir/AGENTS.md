# SmartCodeReview data directory - guide for agents

This directory is the complete local state of SmartCodeReview. Everything is plain, pretty-printed JSON
or text. The app re-reads files on every request, so your edits show up in the UI immediately.

## Layout

```
AGENTS.md              this file (rewritten on every app start)
rules.default.json     built-in classification rules (rewritten on start; reference only)
rules.json             OPTIONAL custom rules; takes precedence; edits trigger re-analysis
settings.json          switched-off categories {"disabledCategories": [...]}: hidden, their places need no ok
reviews/<provider>/<owner>/<repo>/<number>/      provider: github | gitlab; nested GitLab groups: group~sub;
                                                   number 0 = the whole repository (every file counts as new)
  snapshot.json        PR metadata + parsed diff (frozen when the PR was first opened)
  sources/<path>       new version of each analysed file
  sources-base/<path>  old version (at the PR's base commit) of each changed test file, under its OLD path
                       (renamed files); only for the Spec-Diff (`specs[]`); none for number 0
  analysis.json        derived: segments, categories, flows (safe to delete; recomputed)
  review.json          THE ONLY REAL STATE: which changed lines are marked "ok" (per place)
  comments.json        cache of the last comment fetch (GitHub or GitLab)
  commits.json         derived: the PR's commits (oldest first) and `lines` path -> line key -> commit sha
                       (added line: commit that last wrote it; deleted line: commit that removed it)
  blame/<path>.json    cache: git blame of a file at the PR head (`ranges` of new-file lines -> sha)
```

## Line keys

`N<n>` = line n of the NEW file (added line), `O<n>` = line n of the OLD file (deleted line).
Only changed lines can be marked. Valid keys per segment: `analysis.json` → `segments[].lineKeys`.

## Reading a review

1. `analysis.json` → `categories[]` (Quick wins, Datenflüsse, Einzelne Änderungen, Tests, Styles & Assets)
   → `groups[].segmentIds`.
2. `segments[]` → `path`, `symbol`, `category`, `group`, `reason`, `lineKeys`, `lines` (display lines incl.
   context; `refs` on call sites point to called segments).
3. `flows[]` → `steps[]` in call order (`depth`, `parentSegmentId`) and `edges[]` (`from` → `to`, call-site `line`).
4. `segments[].places` → every group id that shows the segment (e.g. `quick-wins/mapper`, `flows/flow-2`).
   A segment at several places needs one ok per place.
5. `tests[]` → per changed test case: `subjects` (components under test) and `covers` (reached segments,
   `direct` or `via` another segment, `line` = call site in the test). `segments[].testedBy` is the reverse.
   `coverage[]` is the view from the code (static; only changed tests and changed code): one entry per testable
   changed function (function/method/component outside tests whose category has `needsTests`, default true;
   false for quick wins, tests, styles, config, API contracts; trivial getters/setters whose body is only
   `return x;` / `this.x = x;` are always left out). `status`: `direct` (a changed test
   calls it), `indirect` (only reached via other changed code), `none` (no changed test reaches it);
   `directTests` / `indirectTests` = test segment ids; `branches` = decision points in the whole function
   (if, case, catch, for, while, &&, ||, ternary ?); `changedLines` = non-blank, non-brace changed lines;
   `risk` = changedLines × (1 + branches). Sorted: `none`, `indirect`, `direct`, each by risk descending.
   Missing (null) in analyses of older versions.
   `specs[]` (Spec-Diff) = per changed test file (`path`, `previousPath`, file `status`) the test names as an
   outline, old against new version: `entries[]` with `name`, `suites` (enclosing suites, outermost first; JUnit:
   test class and @Nested classes), `kind` (suite | test), `status` (added | removed | changed | renamed |
   unchanged), `previousName` (renamed), `segmentId` (null for removed and untouched entries), `line` (new file),
   `oldLine` (base version), `depth` (indentation). Matched by full path, renames = same text apart from
   whitespace and the name. `baseAvailable: false` = the old version could not be loaded, only the new side is
   listed. Entries in new file order, removed ones after their previous old sibling. Null in older analyses.
   Changed expectations (pattern-based, rules `assertions` / `weakAssertions` / `disabledTests`): `expectations[]`
   per matched entry with `kind` (changed = same subject, other expected value/matcher | weakened = to a matcher
   that only checks existence/truthiness, or removed while only such remain | removed | added | disabled |
   enabled = the test or an enclosing suite was switched off/on), `oldText` / `newText` (the assertion statement,
   or the switching line), `oldLine` / `newLine` (null where that side does not exist); empty for added/removed
   entries and without base. `assertionsBefore` / `assertionsAfter` = assertion statements in the test body
   (null for suites and missing sides); `disabled` = switched off now (xit, it.skip, @Disabled, t.Skip, ...).
   A test that now expects something else or less is how tests get bent to fit broken code: check these first.
6. `architecture.style` = "hexagonal" when the repo uses ports & adapters, "layered" for domain / application /
   adapter packages without ports; then `segments[].layer` is domain | application | usecase | adapter.
   `segments[].frontend` marks web frontend code. `flows[].edges[].kind` = "http" for REST calls from the
   frontend into a backend endpoint (literal URLs, or generated OpenAPI clients matched by operationId; `via`
   then ends with `(operationId)`). Flow titles start with the trigger when known (`JMS-Listener: …`, `PUT /x: …`).
   Cross-cutting categories: `api-contract`, `security`, `messaging`, `transactions`, `persistence`, `runtime`.
   `reviews/…/structure.json` holds the repository directories and the API contract `operations`.
7. `components[]` / `componentEdges[]`: changed files grouped into components and the calls between them.

## Marking lines as ok

Preferred while the app runs (no write conflicts):

```
POST http://localhost:8080/api/prs/<provider>/<owner>/<repo>/<number>/marks
{"lines":[{"path":"src/a.ts","key":"N12"}],"ok":true,"scope":"group:quick-wins/übersetzungen","by":"agent:<your-name>"}
```

Without `place` a mark applies at all places of the line. To mark one place only, add `"place": "flows/flow-2"`.

Or edit `review.json` directly:

```json
{ "schemaVersion": 1, "pr": "github/owner/repo/12", "headSha": "…",
  "ok": { "src/a.ts": ["N12", "N13"] },
  "okAt": { "flows/flow-2": { "src/b.ts": ["N40"] } },
  "log": [ { "at": "<ISO-8601>", "by": "agent:<your-name>", "action": "ok", "scope": "<what you marked>", "count": 2 } ] }
```

Rules for direct edits: read first, write the whole file atomically (temp file + rename), keep keys sorted,
only use keys from `lineKeys`, always append a `log` entry with `"by": "agent:<name>"`.
`ok` = ok at all places of the line; `okAt[place]` = ok at that place only. When a line is ok at all its places,
move it to `ok` and remove it from `okAt`.

## Other endpoints

* `GET  /api/prs` – open PRs/MRs (authored by the user or review requested) of all configured hosts
* `GET  /api/resolve?url=<PR or MR web URL>` – turns a GitHub/GitLab URL into provider/owner/repo/number
* `GET  /api/prs/<provider>/<owner>/<repo>/<number>` – bundle (also creates the files above)
* `POST …/reanalyse` – recompute analysis.json (e.g. after editing rules.json)
* `GET  …/commits` – commits.json (computed on first call); to review commit by commit, mark the line keys
  that `lines` assigns to one sha
* `GET  …/blame?path=<changed file>` – git blame at the PR head
* `GET  …/comments`, `POST …/comments` – comments; POST publishes IMMEDIATELY on GitHub/GitLab:
  inline `{"path":"src/a.ts","line":12,"side":"RIGHT","body":"…"}`, reply `{"inReplyTo":123,"body":"…"}`,
  general `{"body":"…"}`. For unchanged context lines also send `oldLine` and `newLine` (GitLab needs both).
  Only comment when the user asked you to.
