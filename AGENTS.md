# Working on CodeReviewLens

Review tool: Quarkus backend (`backend/`) + Angular UI (`frontend/`). Start with `README.md`, the
design decisions are in `docs/` (German): architecture overview `docs/09`, requirements `docs/10`, known improvements
`docs/11`. When adding or changing a feature, update its requirement in `docs/10-anforderungen.md`.

## Rules

- **Language:** Docs are German (Swiss spelling: «ss», never «ß»). The UI is German and English: German is the source
  language, every UI text goes through `t('…')` (`frontend/src/app/i18n.ts`) with its English text in `i18n.en.ts`
  (British spelling, GitHub/GitLab/IntelliJ terms). Texts the backend sends stay German in files and API and are shown
  through `serverText()`; add the English for new or changed ones to `i18n.server.en.ts` (`i18n.spec.ts` checks it).
  Code, comments, commit messages: English.
- **No AI in the analysis.** Categorisation and flows are pattern-based and deterministic (`backend/.../analysis/`).
  New heuristics go into `default-rules.json` when they can be expressed as rules.
- **Bump `Analyzer.VERSION`** whenever analysis output changes, so cached `analysis.json` files are recomputed.
- **Categories are modules.** Each category is a `CategoryModule` (`analysis/category/`) that sees only `SegmentFacts`,
  never the analyzer or another module, and describes itself (`builds`/`divides`, shown in the UI). New heuristics that
  fit a rule go into `default-rules.json`; special UIs (like flows) are declared via `view()`, never by category id in the UI.
  Accept/half-accept rules for lines at several places live only in `review/LineAcceptance` (+ its mirror `acceptance.ts`).
- **`Model.java` is the file format.** Field names are a contract with agents (see `docs/04-persistenz-und-agenten.md`
  and `backend/src/main/resources/data-dir/AGENTS.md`); extend, don't rename.
- **Native-friendly backend:** records with `@RegisterForReflection`, Jackson trees for external JSON, new classpath
  resources must be added to `quarkus.native.resources.includes`.
- **UI look:** IntelliJ New UI, dark (default) and light (`theme.ts`). Colours only as tokens in `frontend/src/styles.scss`
  (incl. the palettes `--edge-n` for connections, `--area-*` for layers, `--lang-*` for languages, `--syn-*` for syntax;
  helpers in `frontend/src/app/look.ts`), never inline hex values; every new token needs a value in both the `:root`
  (dark) and the `:root[data-theme='light']` block.
- **No cache resets:** every file the UI loads has a content hash in its name (Angular `outputHashing: all`), except
  `index.html`. Don't add unhashed files referenced by the page (no `public/` assets; inline small ones like the
  favicon). Cache headers live in `application.properties` (`quarkus.http.filter.*`): hashed = immutable,
  everything else `no-cache`, `/api` `no-store`.
- **Provider-neutral:** only `github/` and `gitlab/` know their host; everything else talks to `ReviewProvider`.
  GitLab merge requests are "pull requests" internally; nested groups are encoded as `group~sub` in `PrRef.owner`.

## Commands

```bash
cd frontend && npm run build          # writes into backend/src/main/resources/META-INF/resources
cd backend && ./mvnw quarkus:dev      # http://localhost:8080
cd backend && ./mvnw test             # unit tests (parser, symbols, analysis)
docker compose up --build             # native image (culmi/code-review-lens)
./release.sh X.Y.Z                    # release: version, image, tag, push (Git Bash; see docs/08-versionierung.md)
DOCKERHUB_TOKEN=... ./dockerhub-overview.sh   # Docker Hub page from DOCKERHUB.md (release.sh does it when the token is set)
```

Add user-visible changes to `CHANGELOG.md` under `## [Unreleased]` (German, like the docs).

## Delivering changes

Deliver every finished piece of work as a reviewable pull request, without asking first:

1. **Branch:** work on `feature/<topic>` off `main`. Before creating or reusing one, check for an existing feature
   branch (`git branch -a`, `gh pr list`): the current branch, a local or remote branch for the same topic, or any
   other unmerged `feature/*`. If one exists, warn the user up front: name it, its commits ahead of `main`, whether
   it is pushed and whether a PR is open, and say whether you continue on it or start a new branch.
2. **Commits:** split the work into focused commits, one per logical change (e.g. a feature with its tests and docs;
   an unrelated fix; test data in `docs/06-test-prs.md` with the feature it shows). Every commit builds and passes
   `./mvnw test`. When one file holds several changes, stage them separately (`git apply --cached` with a partial patch).
3. **Push:** `git push -u origin <branch>`; never force-push.
4. **PR:** if the branch has no open PR, open one against `main` with `gh pr create` (title and description in
   German, like PR #1: what changed, how to check it, e.g. on which test PR, and the test results). If a PR is open,
   the push updates it. End your turn with the PR link.
