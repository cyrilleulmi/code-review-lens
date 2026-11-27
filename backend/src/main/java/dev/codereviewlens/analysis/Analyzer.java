package dev.codereviewlens.analysis;

import dev.codereviewlens.analysis.SymbolExtractor.Symbol;
import dev.codereviewlens.analysis.category.CategoryContext;
import dev.codereviewlens.analysis.category.CategoryInfo;
import dev.codereviewlens.analysis.category.CategoryModule;
import dev.codereviewlens.analysis.category.SegmentFacts;
import dev.codereviewlens.model.Model;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.ApiOperation;
import dev.codereviewlens.model.Model.ArchitectureInfo;
import dev.codereviewlens.model.Model.CaseMatrix;
import dev.codereviewlens.model.Model.CaseRow;
import dev.codereviewlens.model.Model.Category;
import dev.codereviewlens.model.Model.CodeCoverage;
import dev.codereviewlens.model.Model.Component;
import dev.codereviewlens.model.Model.ComponentEdge;
import dev.codereviewlens.model.Model.DiffFile;
import dev.codereviewlens.model.Model.DiffLine;
import dev.codereviewlens.model.Model.DisplayLine;
import dev.codereviewlens.model.Model.ExistingTest;
import dev.codereviewlens.model.Model.Flow;
import dev.codereviewlens.model.Model.FlowEdge;
import dev.codereviewlens.model.Model.Signature;
import dev.codereviewlens.model.Model.TypeField;
import dev.codereviewlens.model.Model.TypeInfo;
import dev.codereviewlens.model.Model.FlowStep;
import dev.codereviewlens.model.Model.Group;
import dev.codereviewlens.model.Model.Hunk;
import dev.codereviewlens.model.Model.LineRef;
import dev.codereviewlens.model.Model.MatrixBoundary;
import dev.codereviewlens.model.Model.MockWarning;
import dev.codereviewlens.model.Model.RelatedTestFile;
import dev.codereviewlens.model.Model.RepoStructure;
import dev.codereviewlens.model.Model.RuleCheck;
import dev.codereviewlens.model.Model.Segment;
import dev.codereviewlens.model.Model.Snapshot;
import dev.codereviewlens.model.Model.SpecFile;
import dev.codereviewlens.model.Model.TestCoverage;
import dev.codereviewlens.model.Model.TestInfo;
import dev.codereviewlens.model.Model.TestProfile;
import dev.codereviewlens.model.Model.TestSmell;
import dev.codereviewlens.model.Model.TestSubject;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Turns a PR snapshot into review segments, categories and data flows - without AI:
 * <ol>
 *   <li>Every changed line is assigned to the innermost function/class/type that contains it (or to the
 *       hunk/module level), giving <em>segments</em>.</li>
 *   <li>Path rules and line-pattern rules (rules.json) mark segments as quick wins, tests, styles.</li>
 *   <li>Changed functions that reference each other (name match + import check) are connected; every entry
 *       point gets a <em>flow</em> with everything it reaches, in call order. A function reached from two entry
 *       points is part of both flows.</li>
 *   <li>Changed test cases are linked to the changed code they reach through the same call graph; seen from the
 *       code, every testable changed function gets a coverage status (direct, indirect, none) and a branch count.
 *       Code of a collaborator a test mocks is reached only as a mock: the walk stops there and it does not count as
 *       covered; tests that stub changed members of a mock get a warning, every flow a per step/edge view of what the
 *       tests really execute (<em>Mock-Grenzen</em>, {@link MockBoundaries}).
 *       Every changed test case gets a profile (<em>Test-Steckbrief</em>, {@link TestProfiles}). Existing, unchanged
 *       test files loaded for the change ({@link RelatedTests}) are linked the same way (<em>Bestehende Tests</em>,
 *       coverage status "existing"); they are no segments. Per testable function, its error outcomes, boundaries and
 *       effects are compared with what the reaching tests check (<em>Fall- und Effekt-Abgleich</em>, {@link CaseChecks}).
 *       Rules of the form "if X changes, expect a test of form Y" are checked per changed segment
 *       (<em>Erwartungs-Regeln</em>, {@link TestRules}). A test that sends a real HTTP request to a changed endpoint
 *       reaches it directly and, from there, what it calls (<em>HTTP-Tests</em>, {@link HttpTests}); requests a test
 *       with a mocked backend expects are shown on the REST edges of the flows.</li>
 *   <li>Frontend REST calls are matched to backend endpoints (http edges), so a flow can run from a component
 *       through the API client into the backend.</li>
 *   <li>Ports &amp; adapters projects get a layer per segment (domain, use case, application, adapter); frontend
 *       segments get an aspect (routing, state, API, forms, components, templates). Both are extra categories.</li>
 *   <li>Every segment lists its <em>places</em> (all groups that show it); each place needs its own "ok".</li>
 *   <li>Changed files are combined into <em>components</em> with the calls between them (overview diagram).</li>
 *   <li>The test names of changed test files are compared with their base version (<em>Spec-Diff</em>, {@link Specs}).</li>
 *   <li>Similar and parameterised tests of changed test files become tables input → expected (<em>Fallmatrix</em>,
 *       {@link CaseMatrices}).</li>
 * </ol>
 */
public final class Analyzer {

    private static final int CONTEXT = 2;
    private static final int MAX_DISPLAY_LINES = 400;
    /** Methods that are called by frameworks, never explicitly; not used as call targets. */
    private static final Set<String> NOT_CALLED = Set.of("constructor", "render", "ngOnInit", "ngOnDestroy",
            "ngOnChanges", "ngAfterViewInit", "ngDoCheck", "toString", "equals", "hashCode", "main", "default",
            "GET", "POST", "PUT", "PATCH", "DELETE");
    /** Names too generic to link by mere mention; they need call syntax `name(`. */
    private static final Set<String> GENERIC = Set.of("get", "set", "run", "data", "value", "config", "index",
            "init", "load", "save", "update", "create", "remove", "handle", "handler", "process", "build", "parse",
            "format", "map", "filter", "reduce", "find", "fetch", "send", "close", "open", "start", "stop", "reset",
            "submit", "validate", "transform", "convert", "item", "items", "list", "result", "options", "props", "state");
    /** The generic names, for other analyses that link by name (see {@link SetupImpact}). */
    static final Set<String> GENERIC_NAMES = GENERIC;
    private static final Pattern IMPORT_START =Pattern.compile("^\\s*import\\b");
    private static final Pattern MODULE_SYNTAX = Pattern.compile("^\\s*export\\b|\\brequire\\s*\\(|\\bmodule\\.exports\\b");
    private static final Pattern ENTRY_LAYER = Pattern.compile(
            "(?i)(component|page|route|controller|resource|endpoint|handler|view|screen|listener|consumer|messaging/|app/|pages/|api/)");
    private static final Pattern DEEP_LAYER = Pattern.compile("(?i)(repository|repo|dao|store|db|database|client|gateway|adapter|lib/|utils?/|helpers?/)");
    private static final Pattern API_LAYER = Pattern.compile("(?i)(resource|controller|endpoint|handler|route|/api/|/rest/|/web/)");
    private static final Pattern DOMAIN_DIR = Pattern.compile("(?i)/(domain|model|models|entity|entities)/");
    /** Bump when the analysis logic changes, so stored analyses are recomputed. */
    public static final int VERSION = 33;

    /** Asynchronous / framework entry points: shown as the trigger in the title of a flow that starts there. */
    private static final List<Map.Entry<Pattern, String>> TRIGGERS = List.of(
            Map.entry(Pattern.compile("@JmsListener\\b"), "JMS-Listener"),
            Map.entry(Pattern.compile("@KafkaListener\\b"), "Kafka-Listener"),
            Map.entry(Pattern.compile("@RabbitListener\\b"), "RabbitMQ-Listener"),
            Map.entry(Pattern.compile("@SqsListener\\b"), "SQS-Listener"),
            Map.entry(Pattern.compile("@Incoming\\b"), "Messaging (@Incoming)"),
            Map.entry(Pattern.compile("@(Transactional)?EventListener\\b"), "Event-Listener"),
            Map.entry(Pattern.compile("@Scheduled\\b"), "Zeitgesteuert (@Scheduled)"));
    /** A method call on some receiver: `this.api.updatePlayer(`, `inject(X).getPlayer(`, `api?.list(`. */
    private static final Pattern MEMBER_CALL = Pattern.compile("(?:([\\w$]+)|[)\\]])\\s*\\??\\.\\s*([\\w$]+)\\s*(?:<[^()]*?>)?\\s*\\(");
    /** A class that implements an interface generated from an OpenAPI contract (`implements PlayersApi`). */
    private static final Pattern IMPLEMENTS_API = Pattern.compile("(\\bimplements\\b|\\)\\s*:|\\bclass\\s+\\w+\\s*:)[^{]*\\b\\w+Api(Delegate)?\\b");
    /** Frontend imports that point at a generated API client (used when no contract file is known). */
    private static final Pattern GENERATED_CLIENT_IMPORT = Pattern.compile("['\"][^'\"]*(/gen/|/generated/|openapi|/api['\"/])");
    /** Table names in migrations: Liquibase `tableName: x` / `tableName="x"`, SQL `create/alter/... table x`. */
    private static final List<Pattern> TABLE_IN_MIGRATION = List.of(
            Pattern.compile("tableName['\"]?\\s*[:=]\\s*['\"]?(?:[\\w]+\\.)?([\\w]+)"),
            Pattern.compile("(?i)\\b(?:create|alter|drop|truncate)\\s+table\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?[\\[\"`]?(?:\\w+[\\]\"`]?\\.[\\[\"`]?)?(\\w+)"),
            Pattern.compile("(?i)\\binsert\\s+into\\s+[\\[\"`]?(?:\\w+[\\]\"`]?\\.[\\[\"`]?)?(\\w+)"),
            Pattern.compile("(?i)^\\s*update\\s+[\\[\"`]?(?:\\w+[\\]\"`]?\\.[\\[\"`]?)?(\\w+)\\s+set\\b"));
    private static final Pattern ENTITY = Pattern.compile("@Entity\\b");
    private static final Pattern TABLE_ANNOTATION = Pattern.compile("@Table\\s*\\([^)]*?name\\s*=\\s*\"(?:\\w+\\.)?(\\w+)\"|@Table\\s*\\(\\s*\"(\\w+)\"");

    private final Rules rules;
    private final List<CategoryModule> modules;

    /** Identifies rules + analyzer version; stored in analysis.json to detect outdated analyses. */
    public static String fingerprint(Rules rules) {
        return rules.hash + "@" + VERSION;
    }

    public Analyzer(Rules rules) {
        this.rules = rules;
        this.modules = CategoryModules.build(rules, List.of());
    }

    // ------------------------------------------------------------------ working types

    private static final class FileCtx {
        DiffFile diff;
        CodeText text;
        List<Symbol> symbols;
        FileView view;
        String source;
        String importsText;
        Set<Integer> importLines; // 0-based
        boolean module; // uses import/export/require; plain scripts share one global scope
        /** importsFrom results by callee (path, name, container): the same pair is asked once per segment pair */
        final Map<String, Boolean> imports = new HashMap<>();
        /** whether the code mentions a class name (Java/Kotlin same-package check) */
        final Map<String, Boolean> mentions = new HashMap<>();
    }

    private static final class Work {
        String id;
        String kind; // hunk | symbol | module
        DiffFile file;
        FileCtx ctx; // null when the new source is not available
        Hunk hunk; // for hunk/module
        Symbol symbol;
        final List<DiffLine> changed = new ArrayList<>();
        final Map<DiffLine, Integer> anchors = new HashMap<>();
        Rules.Rule rule;
        String category;
        String group;
        String reason;
        boolean frontend;
        String layer; // ports & adapters layer, null if none
        Rules.Rule aspect; // frontend aspect (extra category), null if none
        List<String> concerns = List.of(); // cross-cutting categories (security, messaging, ...)
        String trigger; // how a flow starting here is triggered (endpoint, JMS listener, ...), null if unknown
        final Map<Integer, List<LineRef>> refs = new HashMap<>();

        int sortLine() {
            return symbol != null ? symbol.startLine() : anchors.values().stream().min(Integer::compare).orElse(0);
        }

        String label() {
            if (symbol != null) {
                return symbol.displayName();
            }
            return file.path().substring(file.path().lastIndexOf('/') + 1);
        }
    }

    // ------------------------------------------------------------------ analysis

    public Analysis analyze(Snapshot snapshot, Map<String, String> sources) {
        return analyze(snapshot, sources, (RepoStructure) null);
    }

    /** directories: all directories of the repository (to recognise ports &amp; adapters); null = only the changed ones. */
    public Analysis analyze(Snapshot snapshot, Map<String, String> sources, Collection<String> directories) {
        return analyze(snapshot, sources, directories == null ? null : new RepoStructure(List.copyOf(directories), false));
    }

    /**
     * structure: directories of the repository (architecture) and the operations of its API contracts (links
     * through generated clients); null = only what the diff shows.
     */
    public Analysis analyze(Snapshot snapshot, Map<String, String> sources, RepoStructure structure) {
        return analyze(snapshot, sources, structure, Map.of());
    }

    /**
     * baseSources: the base version of changed test files (Spec-Diff), by their path in the base version
     * ({@link Specs#basePath}); missing entries mean "base not available".
     */
    public Analysis analyze(Snapshot snapshot, Map<String, String> sources, RepoStructure structure,
                            Map<String, String> baseSources) {
        return analyze(snapshot, sources, structure, baseSources, null, Map.of());
    }

    /**
     * related: the existing test files selected for the change ({@link RelatedTests}; null = none looked for, e.g. a
     * whole repository); relatedSources: their content at the PR head by path (missing = could not be loaded). Their
     * test cases are linked to the changed code (Analysis.existingTests) but are no segments.
     */
    public Analysis analyze(Snapshot snapshot, Map<String, String> sources, RepoStructure structure,
                            Map<String, String> baseSources, Model.RelatedTests related, Map<String, String> relatedSources) {
        Collection<String> directories = structure == null ? null : structure.directories();
        List<ApiOperation> operations = structure == null || structure.operations() == null ? List.of() : structure.operations();
        List<Work> works = new ArrayList<>();
        for (DiffFile file : snapshot.files()) {
            segmentFile(file, sources.get(file.path()), works);
        }
        works.sort(Comparator.comparing((Work w) -> w.file.path()).thenComparingInt(Work::sortLine));
        for (int i = 0; i < works.size(); i++) {
            works.get(i).id = "s" + (i + 1);
        }

        for (Work w : works) {
            if (w.rule == null) {
                classifyByLines(w);
            }
            if (isTest(w)) {
                w.group = w.file.path(); // tests are listed per file
                if (w.symbol != null && w.symbol.kind().equals("test")) {
                    w.reason = "Testfall";
                }
            }
        }

        Set<String> dirs = new LinkedHashSet<>(directories == null ? List.of() : directories);
        for (DiffFile f : snapshot.files()) {
            for (String d = dirOf(f.path()); !d.isEmpty(); d = dirOf(d)) {
                dirs.add(d);
            }
        }
        List<String> evidence = Structure.hexagonalEvidence(dirs);
        for (Work w : works) {
            String source = sources.get(w.file.path());
            w.frontend = Structure.isFrontend(w.file.path(), source);
            if (w.ctx != null && w.symbol != null && w.symbol.isCallable()) {
                String head = String.join("\n", head(w.ctx.text.lines, w.symbol));
                TRIGGERS.stream().filter(t -> t.getKey().matcher(head).find()).findFirst().ifPresent(t -> w.trigger = t.getValue());
            }
            boolean extras = (w.rule == null || w.rule.extras()) && !isTest(w);
            if (!extras) {
                continue;
            }
            if (!evidence.isEmpty() && !w.frontend && Languages.hasSymbols(w.file.language())) {
                w.layer = Structure.layerOf(w.file.path());
            }
            if (w.frontend) {
                w.aspect = rules.aspectFor(w.file.path(), w.symbol == null ? null : w.symbol.name(),
                        w.symbol == null ? null : w.symbol.kind(), segmentText(w), source, w.changed);
            }
            w.concerns = rules.concernsFor(w.file.path(), w.frontend, w.symbol == null ? null : w.symbol.name(),
                    w.symbol == null ? null : w.symbol.kind(), concernText(w), source);
        }

        List<FlowEdge> edges = findEdges(works);
        edges.addAll(findHttpEdges(works, edges, operations));
        linkMigrations(works);
        List<Flow> flows = buildFlows(works, edges);
        Set<String> inFlows = flows.stream().flatMap(f -> f.steps().stream()).map(FlowStep::segmentId).collect(Collectors.toSet());
        for (Work w : works) {
            if (w.category == null) {
                w.category = "logic";
                w.group = w.file.path();
                w.reason = inFlows.contains(w.id) ? "Teil eines Datenflusses" : "Kein Aufrufzusammenhang zu anderen Änderungen gefunden";
            }
        }
        List<Category> categories = categories(works, flows, inFlows);
        Map<String, List<String>> places = new HashMap<>();
        for (Category c : categories) {
            for (Group g : c.groups()) {
                for (String id : g.segmentIds()) {
                    List<String> list = places.computeIfAbsent(id, k -> new ArrayList<>());
                    if (!list.contains(g.id())) {
                        list.add(g.id());
                    }
                }
            }
        }
        TestProfiles profiles = new TestProfiles(rules);
        CaseChecks caseChecks = new CaseChecks(rules);
        Map<String, CaseChecks.Evidence> testEvidence = new HashMap<>();
        TestRules testRules = new TestRules(rules);
        Map<String, TestRules.TestFacts> testFacts = new LinkedHashMap<>();
        Map<String, List<TestRules.EndpointAt>> endpoints = endpoints(works, operations);
        HttpLinks http = new HttpLinks(new HttpTests(rules), endpoints, classPaths(works), new HashMap<>());
        List<MockWarning> mockWarnings = new ArrayList<>();
        // the whole repository has no base: every test would be "added", a huge outline without information; the
        // case matrices would list every similar test of the repository - both only make sense for a change
        boolean repository = snapshot.pr().number() == 0;
        Specs.SegmentLookup lookup = segmentLookup(works);
        List<SpecFile> specList = repository ? List.of()
                : specs(snapshot.files(), sources, baseSources == null ? Map.of() : baseSources, lookup);
        Set<String> newTests = new HashSet<>();
        for (SpecFile f : specList) {
            f.entries().stream().filter(e -> "test".equals(e.kind()) && Specs.ADDED.equals(e.status()) && e.segmentId() != null)
                    .forEach(e -> newTests.add(e.segmentId()));
        }
        List<TestInfo> tests = tests(works, edges, snapshot.files(), profiles, mockWarnings, caseChecks, testEvidence,
                testFacts, new TestSmells(rules), newTests, http);
        List<ExistingTest> existingTests = existingTests(works, edges, related, relatedSources, profiles, mockWarnings,
                caseChecks, testEvidence, testFacts, http);
        mockWarnings.sort(Comparator.comparing(MockWarning::path).thenComparing(w -> w.line() == null ? 0 : w.line())
                .thenComparing(MockWarning::member));
        Map<String, List<String>> testedBy = new HashMap<>();
        for (TestInfo t : tests) {
            t.covers().stream().filter(c -> !c.mocked())
                    .forEach(c -> testedBy.computeIfAbsent(c.segmentId(), k -> new ArrayList<>()).add(t.segmentId()));
        }

        Map<String, Signature> signatures = new HashMap<>();
        List<TypeInfo> types = signatures(works, sources, signatures);
        List<Segment> segments = new ArrayList<>();
        for (Work w : works) {
            segments.add(toSegment(w, places.getOrDefault(w.id, List.of()), testedBy.getOrDefault(w.id, List.of()),
                    signatures.get(w.id)));
        }
        ArchitectureInfo architecture = new ArchitectureInfo(Structure.styleOf(evidence), evidence);
        Map<String, String> componentOf = new HashMap<>();
        List<Component> components = components(works, !evidence.isEmpty(), componentOf);
        List<CaseMatrix> matrices = repository ? List.of() : new CaseMatrices(rules).all(snapshot.files(), sources, lookup);
        addMatrixInputs(matrices, testEvidence);
        Map<String, List<CaseChecks.Boundary>> boundaries = new HashMap<>();
        List<CodeCoverage> coverage = coverage(works, tests, existingTests, caseChecks, testEvidence, boundaries);
        // the whole repository: every endpoint would be "new" and every rule would apply to all code - an audit, no review
        List<RuleCheck> ruleChecks = repository ? List.of()
                : testRules.check(ruleTargets(works, tests, existingTests, endpoints), testFacts);
        return new Analysis(Model.SCHEMA_VERSION, Instant.now().toString(), snapshot.pr().headSha(), fingerprint(rules),
                segments, categories, flows, tests, architecture, components, componentEdges(edges, componentOf),
                coverage,
                specList,
                withBoundaries(matrices, tests, boundaries),
                existingTests, related, List.copyOf(mockWarnings), MockBoundaries.flowCoverage(flows, tests, existingTests, http.expectations(), endpoints),
                ruleChecks,
                // the whole repository: every setup piece would be "new" and affect only new tests - nothing to warn about
                repository ? List.of() : setupImpacts(works, specList, related, relatedSources),
                types);
    }

    // ------------------------------------------------------------------ signatures and the types they name

    /** A type declared in an analysed file. */
    private record TypeDecl(String path, String language, CodeText text, Symbol symbol) {
        String id() {
            return path + "#" + symbol.name();
        }
    }

    private static final Set<String> TYPE_KINDS = Set.of("class", "interface", "type", "enum");

    /**
     * The signature of every changed function, method and component (into `out`, by segment id) and the types these
     * signatures name, with their fields. A type is known when a file of the change with a source declares it - also
     * a file that is segmented by a path rule only (DTO and model files). Types in unchanged files are not loaded.
     */
    private static List<TypeInfo> signatures(List<Work> works, Map<String, String> sources, Map<String, Signature> out) {
        Map<String, FileCtx> parsed = new HashMap<>();
        works.stream().filter(w -> w.ctx != null).forEach(w -> parsed.putIfAbsent(w.file.path(), w.ctx));
        Map<String, List<TypeDecl>> declared = new HashMap<>();
        for (String path : new TreeSet<>(sources.keySet())) {
            String language = Languages.of(path);
            String source = sources.get(path);
            if (source == null || !Languages.hasSymbols(language)) {
                continue;
            }
            FileCtx ctx = parsed.get(path);
            CodeText text = ctx != null ? ctx.text : CodeText.of(source);
            List<Symbol> symbols = ctx != null ? ctx.symbols : SymbolExtractor.extract(text, path);
            for (Symbol s : symbols) {
                if (TYPE_KINDS.contains(s.kind())) {
                    declared.computeIfAbsent(s.name(), k -> new ArrayList<>()).add(new TypeDecl(path, language, text, s));
                }
            }
        }
        Map<String, TypeInfo> used = new HashMap<>();
        for (Work w : works) {
            if (w.ctx == null || w.symbol == null) {
                continue;
            }
            Signature s = Signatures.of(w.ctx.text, w.symbol, w.file.language());
            if (s == null) {
                continue;
            }
            List<String> ids = new ArrayList<>();
            for (String name : Signatures.typeNames(s)) {
                TypeDecl d = typeFor(name, w, declared.getOrDefault(name, List.of()));
                if (d != null && !ids.contains(d.id())) {
                    used.computeIfAbsent(d.id(), id -> typeInfo(d));
                    ids.add(d.id());
                }
            }
            out.put(w.id, new Signature(s.declaration(), s.params(), s.returns(), List.copyOf(ids)));
        }
        return used.values().stream()
                .sorted(Comparator.comparing(TypeInfo::path).thenComparing(TypeInfo::line).thenComparing(TypeInfo::name)).toList();
    }

    /**
     * The declaration a type name in a signature means, of those with that name (by path): the one in the same file,
     * else in the same directory, else one whose file the caller's imports name, else the first.
     */
    private static TypeDecl typeFor(String name, Work user, List<TypeDecl> candidates) {
        if (candidates.isEmpty()) {
            return null;
        }
        String path = user.file.path();
        String imports = user.ctx.importsText == null ? "" : user.ctx.importsText;
        return candidates.stream().filter(d -> d.path().equals(path)).findFirst()
                .or(() -> candidates.stream().filter(d -> dirOf(d.path()).equals(dirOf(path))).findFirst())
                .or(() -> candidates.stream().filter(d -> imports.contains(stemOf(d.path()))).findFirst())
                .orElse(candidates.get(0));
    }

    private static TypeInfo typeInfo(TypeDecl d) {
        List<TypeField> fields = Signatures.fieldsOf(d.text(), d.symbol(), d.language());
        int shown = Math.min(fields.size(), Signatures.MAX_FIELDS);
        return new TypeInfo(d.id(), d.symbol().name(), d.path(), d.symbol().kind(), d.symbol().startLine(),
                List.copyOf(fields.subList(0, shown)), fields.size() - shown);
    }

    /**
     * Wirkung von Setup und Testdaten (see {@link SetupImpact}): the changed setup blocks, fixtures and helpers of test
     * and test-support files with the tests they affect - in all test files of the PR (with the status of each test from
     * the Spec-Diff) and in the existing test files loaded for the change (all unchanged).
     */
    private List<Model.SetupImpact> setupImpacts(List<Work> works, List<SpecFile> specs, Model.RelatedTests related,
                                                 Map<String, String> relatedSources) {
        Map<String, Map<Integer, Model.SpecEntry>> specByLine = new HashMap<>();
        for (SpecFile f : specs) {
            Map<Integer, Model.SpecEntry> byLine = specByLine.computeIfAbsent(f.path(), k -> new HashMap<>());
            f.entries().stream().filter(e -> "test".equals(e.kind()) && e.line() != null).forEach(e -> byLine.putIfAbsent(e.line(), e));
        }
        Map<FileCtx, List<Work>> byFile = new LinkedHashMap<>();
        for (Work w : works) {
            if (w.ctx != null && !"removed".equals(w.file.status()) && SetupImpact.isTestOrSupport(rules, w.file.path())) {
                byFile.computeIfAbsent(w.ctx, k -> new ArrayList<>()).add(w);
            }
        }
        if (byFile.isEmpty()) {
            return List.of();
        }
        List<SetupImpact.TestFile> files = new ArrayList<>();
        List<SetupImpact.Changed> changed = new ArrayList<>();
        for (Map.Entry<FileCtx, List<Work>> e : byFile.entrySet()) {
            FileCtx ctx = e.getKey();
            String path = ctx.diff.path();
            Map<Symbol, String> segmentOf = new HashMap<>();
            for (Work w : e.getValue()) {
                if (w.symbol != null) {
                    segmentOf.put(w.symbol, w.id);
                    Set<Integer> added = new TreeSet<>();
                    Map<Integer, String> deleted = new LinkedHashMap<>();
                    for (DiffLine l : w.changed) {
                        if ("del".equals(l.type())) {
                            deleted.putIfAbsent(w.anchors.getOrDefault(l, 0), l.text());
                        } else if (l.newLine() != null) {
                            added.add(l.newLine());
                        }
                    }
                    changed.add(new SetupImpact.Changed(w.id, path, w.symbol, added, deleted));
                }
            }
            Map<Integer, Model.SpecEntry> entries = specByLine.getOrDefault(path, Map.of());
            boolean addedFile = Specs.ADDED.equals(ctx.diff.status());
            files.add(new SetupImpact.TestFile(path, ctx.text, ctx.symbols, false, test -> {
                Model.SpecEntry entry = entries.get(test.startLine());
                String segment = segmentOf.get(test);
                if (entry != null) {
                    return new SetupImpact.TestState(entry.status(), entry.segmentId() != null ? entry.segmentId() : segment);
                }
                return new SetupImpact.TestState(segment == null ? Specs.UNCHANGED : addedFile ? Specs.ADDED : Specs.CHANGED, segment);
            }));
        }
        if (related != null && related.files() != null && relatedSources != null) {
            for (RelatedTestFile f : related.files()) {
                String source = relatedSources.get(f.path());
                if (source != null && Languages.hasSymbols(Languages.of(f.path()))) {
                    CodeText text = CodeText.of(source);
                    files.add(new SetupImpact.TestFile(f.path(), text, SymbolExtractor.extract(text, f.path()), true, null));
                }
            }
        }
        return SetupImpact.find(changed, files);
    }

    /** The input values of the Fallmatrix rows of changed tests count as inputs of those tests (Fall- und Effekt-Abgleich). */
    private static void addMatrixInputs(List<CaseMatrix> matrices, Map<String, CaseChecks.Evidence> evidence) {
        for (CaseMatrix m : matrices) {
            for (CaseRow r : m.rows()) {
                CaseChecks.Evidence e = r.segmentId() == null ? null : evidence.get(r.segmentId());
                if (e == null) {
                    continue;
                }
                for (int c = 0; c < m.columns().size() && c < r.values().size(); c++) {
                    if (CaseMatrices.INPUT.equals(m.columns().get(c).role())) {
                        CaseChecks.addValue(e, r.values().get(c));
                    }
                }
            }
        }
    }

    /**
     * Boundary hints of each Fallmatrix with numeric inputs: the boundaries in the changed code its rows' tests really
     * reach (directly or indirectly, not mocked), with the boundary values none of its rows feeds in.
     */
    private static List<CaseMatrix> withBoundaries(List<CaseMatrix> matrices, List<TestInfo> tests,
                                                   Map<String, List<CaseChecks.Boundary>> boundaries) {
        Map<String, TestInfo> byId = new HashMap<>();
        tests.forEach(t -> byId.put(t.segmentId(), t));
        List<CaseMatrix> result = new ArrayList<>();
        for (CaseMatrix m : matrices) {
            Set<Long> inputs = new TreeSet<>();
            for (CaseRow r : m.rows()) {
                for (int c = 0; c < m.columns().size() && c < r.values().size(); c++) {
                    Long n = CaseMatrices.INPUT.equals(m.columns().get(c).role()) ? CaseChecks.number(r.values().get(c)) : null;
                    if (n != null) {
                        inputs.add(n);
                    }
                }
            }
            Set<String> reached = new LinkedHashSet<>();
            m.rows().stream().map(CaseRow::segmentId).filter(Objects::nonNull).distinct().map(byId::get).filter(Objects::nonNull)
                    .forEach(t -> t.covers().stream().filter(c -> !c.mocked()).forEach(c -> reached.add(c.segmentId())));
            List<MatrixBoundary> hints = new ArrayList<>();
            if (!inputs.isEmpty()) {
                for (String id : reached) {
                    for (CaseChecks.Boundary b : boundaries.getOrDefault(id, List.of())) {
                        hints.add(new MatrixBoundary(id, b.subject(), b.label(), b.values().stream().map(String::valueOf).toList(),
                                CaseChecks.missingIn(b, inputs)));
                    }
                }
            }
            result.add(new CaseMatrix(m.id(), m.path(), m.title(), m.kind(), m.template(), m.columns(), m.rows(), List.copyOf(hints)));
        }
        return result;
    }

    /** The segment of a changed symbol (path + symbol of the new version), null for unchanged symbols. */
    private static Specs.SegmentLookup segmentLookup(List<Work> works) {
        Map<String, Map<Symbol, String>> segmentOf = new HashMap<>();
        for (Work w : works) {
            if (w.symbol != null) {
                segmentOf.computeIfAbsent(w.file.path(), k -> new HashMap<>()).put(w.symbol, w.id);
            }
        }
        return (path, symbol) -> segmentOf.getOrDefault(path, Map.of()).get(symbol);
    }

    /** Spec-Diff: the test names of every changed test file, old against new version (see {@link Specs}). */
    private List<SpecFile> specs(List<DiffFile> files, Map<String, String> sources, Map<String, String> baseSources,
                                 Specs.SegmentLookup lookup) {
        Expectations expectations = new Expectations(rules);
        List<SpecFile> result = new ArrayList<>();
        for (DiffFile f : files) {
            if (Specs.isTestFile(rules, f)) {
                SpecFile spec = Specs.of(f, sources.get(f.path()),
                        Specs.ADDED.equals(f.status()) ? null : baseSources.get(Specs.basePath(f)), lookup, expectations);
                if (spec != null) {
                    result.add(spec);
                }
            }
        }
        result.sort(Comparator.comparing(SpecFile::path));
        return result;
    }

    /** The code of a segment as text: the whole symbol, or the changed lines of a hunk/module segment. */
    private static String segmentText(Work w) {
        if (w.ctx != null && w.symbol != null) {
            return String.join("\n", w.ctx.text.lines.subList(w.symbol.startLine() - 1, Math.min(w.symbol.endLine(), w.ctx.text.lines.size())));
        }
        return w.changed.stream().map(DiffLine::text).collect(Collectors.joining("\n"));
    }

    /**
     * The code a concern looks at: functions as a whole (with their annotations); for classes, types and
     * module code only the changed lines plus the declaration (a class "contains" everything).
     */
    private static String concernText(Work w) {
        if (w.ctx != null && w.symbol != null && (w.symbol.isCallable() || "const".equals(w.symbol.kind()))) {
            return segmentText(w);
        }
        String changed = w.changed.stream().map(DiffLine::text).collect(Collectors.joining("\n"));
        if (w.ctx != null && w.symbol != null) {
            return String.join("\n", head(w.ctx.text.lines, w.symbol)) + "\n" + changed;
        }
        return changed;
    }

    private static boolean isTest(Work w) {
        return "tests".equals(w.category);
    }

    private static boolean isTestCase(Work w) {
        return isTest(w) && w.symbol != null && w.symbol.kind().equals("test");
    }

    private void segmentFile(DiffFile file, String source, List<Work> out) {
        Rules.Rule pathRule = rules.forPath(file.path());
        boolean withSymbols = (pathRule == null || pathRule.symbols()) && source != null
                && Languages.hasSymbols(file.language()) && !"removed".equals(file.status());

        if (!withSymbols) {
            for (Hunk h : file.hunks()) {
                Work w = new Work();
                w.kind = "hunk";
                w.file = file;
                w.hunk = h;
                for (DiffLine l : h.lines()) {
                    if (l.changed()) {
                        w.changed.add(l);
                        w.anchors.put(l, FileView.anchorOf(l, h));
                    }
                }
                if (pathRule != null) {
                    applyRule(w, pathRule);
                }
                if (!w.changed.isEmpty()) {
                    out.add(w);
                }
            }
            return;
        }

        FileCtx ctx = new FileCtx();
        ctx.diff = file;
        ctx.source = source;
        ctx.text = CodeText.of(source);
        ctx.symbols = SymbolExtractor.extract(ctx.text, file.path());
        ctx.view = FileView.build(ctx.text.lines, file.hunks());
        indexImports(ctx);

        Map<Symbol, Work> bySymbol = new LinkedHashMap<>();
        Map<Integer, Work> moduleByHunk = new LinkedHashMap<>();
        for (Hunk h : file.hunks()) {
            Map<DiffLine, Symbol> owner = ownersOf(h, ctx.symbols);
            for (DiffLine l : h.lines()) {
                if (!l.changed()) {
                    continue;
                }
                int anchor = FileView.anchorOf(l, h);
                Symbol s = owner.get(l);
                Work w;
                if (s != null) {
                    w = bySymbol.computeIfAbsent(s, k -> {
                        Work n = new Work();
                        n.kind = "symbol";
                        n.symbol = k;
                        return n;
                    });
                } else {
                    w = moduleByHunk.computeIfAbsent(h.index(), k -> {
                        Work n = new Work();
                        n.kind = "module";
                        n.hunk = h;
                        return n;
                    });
                }
                w.file = file;
                w.ctx = ctx;
                w.changed.add(l);
                w.anchors.put(l, anchor);
            }
        }
        out.addAll(bySymbol.values());
        out.addAll(moduleByHunk.values());
        if (pathRule != null) {
            bySymbol.values().forEach(w -> applyRule(w, pathRule));
            moduleByHunk.values().forEach(w -> applyRule(w, pathRule));
        }
    }

    /**
     * The symbol each changed line of a hunk belongs to (null = module level). Blank changed lines join the
     * neighbouring changed line, so an added method plus its empty separator line stay one segment.
     */
    private static Map<DiffLine, Symbol> ownersOf(Hunk h, List<Symbol> symbols) {
        Map<DiffLine, Symbol> owner = new HashMap<>();
        List<DiffLine> lines = h.lines();
        for (DiffLine l : lines) {
            if (l.changed() && !l.text().isBlank()) {
                int anchor = FileView.anchorOf(l, h);
                owner.put(l, "del".equals(l.type()) ? enclosingGap(symbols, anchor) : SymbolExtractor.innermost(symbols, anchor));
            }
        }
        for (int i = 0; i < lines.size(); i++) {
            DiffLine l = lines.get(i);
            if (!l.changed() || !l.text().isBlank()) {
                continue;
            }
            DiffLine neighbour = null;
            for (int j = i - 1; j >= 0 && lines.get(j).changed() && neighbour == null; j--) {
                neighbour = lines.get(j).text().isBlank() ? null : lines.get(j);
            }
            for (int j = i + 1; j < lines.size() && lines.get(j).changed() && neighbour == null; j++) {
                neighbour = lines.get(j).text().isBlank() ? null : lines.get(j);
            }
            int anchor = FileView.anchorOf(l, h);
            owner.put(l, neighbour != null ? owner.get(neighbour)
                    : "del".equals(l.type()) ? enclosingGap(symbols, anchor) : SymbolExtractor.innermost(symbols, anchor));
        }
        return owner;
    }

    /** Deleted lines sit between line anchor-1 and anchor; they are inside a symbol only if it spans both. */
    private static Symbol enclosingGap(List<Symbol> symbols, int anchor) {
        Symbol best = null;
        for (Symbol s : symbols) {
            if (s.startLine() <= anchor - 1 && s.endLine() >= anchor && (best == null || s.span() < best.span())) {
                best = s;
            }
        }
        return best;
    }

    private static void indexImports(FileCtx ctx) {
        StringBuilder sb = new StringBuilder();
        Set<Integer> lines = new HashSet<>();
        List<String> code = ctx.text.code;
        List<String> raw = ctx.text.lines;
        for (int i = 0; i < code.size(); i++) {
            if (!IMPORT_START.matcher(code.get(i)).find()) {
                continue;
            }
            int j = i;
            boolean goBlock = code.get(i).strip().endsWith("("); // Go: import ( ... )
            while (j < code.size()) {
                lines.add(j);
                sb.append(raw.get(j)).append('\n');
                String c = code.get(j);
                if (goBlock ? j > i && c.strip().startsWith(")")
                        : c.contains(";") || c.contains(" from ") || (j == i && !c.contains("{")) || c.strip().startsWith("}")) {
                    break;
                }
                j++;
            }
            i = j;
        }
        ctx.importsText = sb.toString();
        ctx.importLines = lines;
        ctx.module = !lines.isEmpty() || code.stream().anyMatch(l -> MODULE_SYNTAX.matcher(l).find());
    }

    private void classifyByLines(Work w) {
        Rules.Rule r = rules.forLines(w.changed, w.symbol == null ? null : w.symbol.name(), w.symbol == null ? null : w.symbol.kind(),
                w.ctx == null ? null : concernText(w), w.ctx == null ? null : w.ctx.source);
        if (r != null) {
            applyRule(w, r);
        }
    }

    private static void applyRule(Work w, Rules.Rule r) {
        w.rule = r;
        w.category = r.category();
        w.group = r.group();
        w.reason = r.reason();
    }

    // ------------------------------------------------------------------ call graph

    private List<FlowEdge> findEdges(List<Work> works) {
        List<Work> callees = callees(works);
        List<FlowEdge> edges = new ArrayList<>();
        Map<Work, List<Integer>> searchLines = new HashMap<>();
        for (Work a : works) {
            if (a.ctx != null) {
                searchLines.put(a, searchLinesOf(a, works));
            }
        }
        for (Work a : works) {
            List<Integer> lines = searchLines.get(a);
            if (lines == null) {
                continue;
            }
            for (Work b : callees) {
                if (a == b || (a.symbol != null && b.ctx == a.ctx && b.symbol.contains(a.symbol.startLine()) && b.symbol.span() >= a.symbol.span())) {
                    continue; // self or enclosing symbol
                }
                if (isTest(b) && !isTest(a)) {
                    continue; // production code does not call test helpers
                }
                if (b.ctx != a.ctx && !importsFrom(a.ctx, b)) {
                    continue;
                }
                List<Integer> all = references(a, b, lines);
                // where b is called, the edge shows a call: a line that only names it (a parameter of that name) comes second
                List<Integer> calls = callLines(a, b, all);
                Integer line = preferred(a, calls.isEmpty() ? all : calls);
                if (line != null) {
                    edges.add(new FlowEdge(a.id, b.id, line, b.symbol.name(), "call", calls.isEmpty() ? List.of(line) : calls));
                    a.refs.computeIfAbsent(line, k -> new ArrayList<>()).add(new LineRef(b.id, b.label()));
                }
            }
        }
        return edges;
    }

    /**
     * REST across the stack: HTTP calls in one segment matched to an endpoint in another. Calls: a literal URL
     * (`http.put('/api/x')`, `fetch`) or a generated client method named like an operationId of the API contract
     * (`this.playersService.updatePlayer(...)`). Endpoints: JAX-RS/Spring annotations, Next.js route files,
     * Express/Go route registrations, and methods named like an operationId in a class implementing a generated
     * `...Api` interface. Changed lines of the contract itself link to both sides.
     */
    private List<FlowEdge> findHttpEdges(List<Work> works, List<FlowEdge> callEdges, List<ApiOperation> operations) {
        record Target(Work work, Http.Endpoint endpoint, ApiOperation operation) {
        }
        Map<String, List<ApiOperation>> byOperationId = new HashMap<>();
        operations.forEach(o -> byOperationId.computeIfAbsent(o.operationId(), k -> new ArrayList<>()).add(o));
        List<Target> targets = new ArrayList<>();
        // methods of classes implementing generated API interfaces, by name (works without a contract, too)
        Map<String, List<Work>> implementations = new HashMap<>();
        for (Work b : works) {
            if (b.ctx == null || isTest(b)) {
                continue;
            }
            List<String> raw = b.ctx.text.lines;
            if (b.symbol != null && b.symbol.isCallable()) {
                Http.Endpoint e = Http.annotated(head(raw, b.symbol), classHead(b));
                if (e == null) {
                    e = Http.fileRoute(b.file.path(), b.symbol.name());
                }
                if (e != null) {
                    targets.add(new Target(b, e, null));
                } else if (!b.frontend && IMPLEMENTS_API.matcher(String.join(" ", classHead(b))).find()) {
                    implementations.computeIfAbsent(b.symbol.name(), k -> new ArrayList<>()).add(b);
                    for (ApiOperation o : byOperationId.getOrDefault(b.symbol.name(), List.of())) {
                        targets.add(new Target(b, new Http.Endpoint(o.method(), o.path()), o));
                        b.trigger = b.trigger != null ? b.trigger : o.method() + " " + o.path();
                    }
                }
                if (e != null && b.trigger == null) {
                    b.trigger = e.label();
                }
            }
            int from = b.symbol != null ? b.symbol.startLine() - 1 : b.anchors.values().stream().min(Integer::compare).orElse(1) - 1;
            int to = b.symbol != null ? b.symbol.endLine() - 1 : b.anchors.values().stream().max(Integer::compare).orElse(1) - 1;
            for (int i = Math.max(0, from); i <= Math.min(to, raw.size() - 1); i++) {
                for (Http.Endpoint e : Http.registered(raw.get(i))) {
                    targets.add(new Target(b, e, null));
                }
            }
        }
        List<FlowEdge> edges = new ArrayList<>();
        Map<ApiOperation, Set<Work>> callers = new HashMap<>();
        Map<ApiOperation, Set<Work>> implementers = new HashMap<>();
        targets.stream().filter(t -> t.operation() != null)
                .forEach(t -> implementers.computeIfAbsent(t.operation(), k -> new LinkedHashSet<>()).add(t.work()));
        Set<String> seen = new HashSet<>();
        Set<String> localCalls = callEdges.stream().map(e -> e.from() + ">" + e.via()).collect(Collectors.toSet());
        for (Work a : works) {
            if (a.ctx == null || isTest(a)) {
                continue;
            }
            List<Integer> lines = searchLinesOf(a, works);
            List<Http.Call> calls = new ArrayList<>(Http.calls(a.ctx.text.lines, lines));
            Map<Http.Call, ApiOperation> viaOperation = new HashMap<>();
            if (a.frontend) {
                boolean generatedClient = GENERATED_CLIENT_IMPORT.matcher(a.ctx.importsText).find();
                for (int idx : lines) {
                    if (idx < 0 || idx >= a.ctx.text.code.size()) {
                        continue;
                    }
                    Matcher m = MEMBER_CALL.matcher(a.ctx.text.code.get(idx));
                    while (m.find()) {
                        String name = m.group(2);
                        if ("this".equals(m.group(1)) || localCalls.contains(a.id + ">" + name)) {
                            continue; // own method, or a changed wrapper of the same name (that one calls the API)
                        }
                        for (ApiOperation o : byOperationId.getOrDefault(name, List.of())) {
                            Http.Call call = new Http.Call(o.method(), Http.normalisePath("{}" + o.path()), idx + 1);
                            calls.add(call);
                            viaOperation.put(call, o);
                            callers.computeIfAbsent(o, k -> new LinkedHashSet<>()).add(a);
                        }
                        // no contract known: a generated client method straight to the implementing method
                        if (!byOperationId.containsKey(name) && generatedClient) {
                            for (Work b : implementations.getOrDefault(name, List.of())) {
                                if (seen.add(a.id + ">" + b.id)) {
                                    edges.add(new FlowEdge(a.id, b.id, idx + 1, name + "()", "http"));
                                    a.refs.computeIfAbsent(idx + 1, k -> new ArrayList<>()).add(new LineRef(b.id, name + "() → " + b.label()));
                                }
                            }
                        }
                    }
                }
            }
            for (Http.Call call : calls) {
                ApiOperation op = viaOperation.get(call);
                for (Target t : targets) {
                    if (t.work() != a && t.work().file != a.file && Http.matches(call, t.endpoint()) && seen.add(a.id + ">" + t.work().id)) {
                        String via = t.endpoint().label() + (op != null ? " (" + op.operationId() + ")" : "");
                        edges.add(new FlowEdge(a.id, t.work().id, call.line(), via, "http"));
                        a.refs.computeIfAbsent(call.line(), k -> new ArrayList<>())
                                .add(new LineRef(t.work().id, via + " → " + t.work().label()));
                    }
                }
            }
        }
        linkContracts(works, callers, implementers);
        markApiCallers(works, edges);
        return edges;
    }

    /** Changed lines of an API contract jump to the (changed) callers and implementations of that operation. */
    private static void linkContracts(List<Work> works, Map<ApiOperation, Set<Work>> callers, Map<ApiOperation, Set<Work>> implementers) {
        Set<ApiOperation> all = new LinkedHashSet<>(callers.keySet());
        all.addAll(implementers.keySet());
        for (Work w : works) {
            for (ApiOperation o : all) {
                if (!o.file().equals(w.file.path())) {
                    continue;
                }
                Integer line = w.changed.stream().map(DiffLine::newLine)
                        .filter(n -> n != null && n >= o.line() && n <= o.endLine()).findFirst().orElse(null);
                if (line == null) {
                    continue;
                }
                List<LineRef> refs = w.refs.computeIfAbsent(line, k -> new ArrayList<>());
                implementers.getOrDefault(o, Set.of()).forEach(b -> refs.add(new LineRef(b.id, o.operationId() + " → " + b.label())));
                callers.getOrDefault(o, Set.of()).forEach(a -> refs.add(new LineRef(a.id, "aufgerufen von " + a.label())));
            }
        }
    }

    /** Frontend code that calls the backend belongs to "API-Anbindung" unless an earlier aspect (routing, state, forms) matched. */
    private void markApiCallers(List<Work> works, List<FlowEdge> httpEdges) {
        Rules.Rule api = rules.aspects.stream().filter(r -> r.category().equals("fe-api")).findFirst().orElse(null);
        if (api == null) {
            return;
        }
        Set<String> callers = httpEdges.stream().map(FlowEdge::from).collect(Collectors.toSet());
        for (Work w : works) {
            boolean extras = (w.rule == null || w.rule.extras()) && !isTest(w);
            if (w.frontend && extras && callers.contains(w.id)
                    && (w.aspect == null || rules.aspects.indexOf(w.aspect) > rules.aspects.indexOf(api))) {
                w.aspect = api;
            }
        }
    }

    /**
     * Schema changes and the entities they affect are one review unit: migration hunks (Liquibase/Flyway/SQL)
     * and changed JPA entities that name the same table share a group "Tabelle x" and link to each other.
     */
    private static void linkMigrations(List<Work> works) {
        Map<String, List<Work>> entities = new HashMap<>();
        for (Work w : works) {
            if (w.ctx == null || w.ctx.source == null || isTest(w) || !ENTITY.matcher(w.ctx.source).find()) {
                continue;
            }
            Matcher t = TABLE_ANNOTATION.matcher(w.ctx.source);
            String table = t.find() ? (t.group(1) != null ? t.group(1) : t.group(2))
                    : w.ctx.symbols.stream().filter(s -> s.kind().equals("class")).map(Symbol::name).findFirst().orElse(null);
            if (table != null) {
                entities.computeIfAbsent(tableKey(table), k -> new ArrayList<>()).add(w);
            }
        }
        for (Work m : works) {
            if (!"persistence".equals(m.category) || m.symbol != null || m.hunk == null) {
                continue;
            }
            String first = null;
            for (DiffLine l : m.hunk.lines()) {
                for (Pattern p : TABLE_IN_MIGRATION) {
                    Matcher x = p.matcher(l.text());
                    if (!x.find()) {
                        continue;
                    }
                    String table = x.group(1);
                    first = first == null ? table : first;
                    for (Work e : entities.getOrDefault(tableKey(table), List.of())) {
                        int line = l.newLine() != null ? l.newLine() : m.anchors.values().stream().min(Integer::compare).orElse(1);
                        addRef(m, line, new LineRef(e.id, "Entity " + e.label()));
                        int own = e.changed.stream().map(DiffLine::newLine).filter(n -> n != null).findFirst().orElse(e.sortLine());
                        addRef(e, own, new LineRef(m.id, "Migration " + m.file.path().substring(m.file.path().lastIndexOf('/') + 1)));
                        if ("persistence".equals(e.category)) {
                            e.group = "Tabelle " + table;
                        }
                    }
                }
            }
            if (first != null) {
                m.group = "Tabelle " + first;
            }
        }
    }

    private static void addRef(Work w, int line, LineRef ref) {
        List<LineRef> refs = w.refs.computeIfAbsent(line, k -> new ArrayList<>());
        if (refs.stream().noneMatch(x -> x.segmentId().equals(ref.segmentId()))) {
            refs.add(ref);
        }
    }

    /** PlayerTeam, player_team and "PLAYER_TEAM" name the same table. */
    private static String tableKey(String name) {
        return name.replace("_", "").replace("\"", "").toLowerCase(java.util.Locale.ROOT);
    }

    /** Annotation and declaration lines of a symbol (up to the line that opens its body). */
    private static List<String> head(List<String> raw, Symbol s) {
        List<String> result = new ArrayList<>();
        for (int i = s.startLine() - 1; i < Math.min(raw.size(), s.endLine()); i++) {
            result.add(raw.get(i));
            if (raw.get(i).contains("{")) {
                break;
            }
        }
        return result;
    }

    private static List<String> classHead(Work w) {
        String container = w.symbol.container();
        if (container == null) {
            return List.of();
        }
        return w.ctx.symbols.stream().filter(s -> s.kind().equals("class") && s.name().equals(container)).findFirst()
                .map(s -> head(w.ctx.text.lines, s)).orElse(List.of());
    }

    /**
     * 0-based lines of the caller to scan: for functions their body without imports and nested changed
     * symbols; for classes/types/module-level code only the changed lines (a class "uses" everything).
     */
    private static List<Integer> searchLinesOf(Work a, List<Work> works) {
        List<Integer> result = new ArrayList<>();
        if (a.symbol == null || !(a.symbol.isCallable() || "const".equals(a.symbol.kind()))) {
            for (DiffLine l : a.changed) {
                if (l.newLine() != null && !a.ctx.importLines.contains(l.newLine() - 1)) {
                    result.add(l.newLine() - 1);
                }
            }
            return result;
        }
        List<Symbol> nested = works.stream()
                .filter(o -> o != a && o.ctx == a.ctx && o.symbol != null && o.symbol.span() < a.symbol.span()
                        && a.symbol.contains(o.symbol.startLine()) && a.symbol.contains(o.symbol.endLine()))
                .map(o -> o.symbol).toList();
        for (int line = a.symbol.startLine(); line <= a.symbol.endLine(); line++) {
            int ln = line;
            if (a.ctx.importLines.contains(ln - 1) || nested.stream().anyMatch(n -> n.contains(ln))) {
                continue;
            }
            result.add(ln - 1);
        }
        return result;
    }

    /** Cross-file links need evidence: the caller imports the callee's module, class or name. */
    private static boolean importsFrom(FileCtx caller, Work callee) {
        if (callee.ctx == null) {
            return false;
        }
        // asked for every pair of segments: answer once per caller file and callee (whole repositories!)
        String key = callee.file.path() + "\u0000" + callee.symbol.name() + "\u0000" + callee.symbol.container();
        Boolean known = caller.imports.get(key);
        if (known == null) {
            known = importsFromUncached(caller, callee);
            caller.imports.put(key, known);
        }
        return known;
    }

    private static boolean importsFromUncached(FileCtx caller, Work callee) {
        // classic <script> files without modules: all top-level functions are global
        boolean script = "javascript".equals(caller.diff.language()) && "javascript".equals(callee.file.language());
        if (script && !caller.module && !callee.ctx.module) {
            return true;
        }
        String imports = caller.importsText;
        String path = callee.file.path();
        // Go: files of the same directory form one package and need no import
        if ("go".equals(caller.diff.language()) && "go".equals(callee.file.language()) && dirOf(caller.diff.path()).equals(dirOf(path))) {
            return true;
        }
        String fileName = path.substring(path.lastIndexOf('/') + 1);
        String stem = fileName.contains(".") ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;
        if (stem.equals("index")) {
            String dir = path.contains("/") ? path.substring(0, path.lastIndexOf('/')) : "";
            stem = dir.substring(dir.lastIndexOf('/') + 1);
        }
        if (Pattern.compile("[/'\"]" + Pattern.quote(stem) + "['\"./]").matcher(imports).find()) {
            return true;
        }
        // Go imports packages (directories), not files
        if ("go".equals(callee.file.language()) && path.contains("/")) {
            String dir = path.substring(0, path.lastIndexOf('/'));
            if (imports.contains("/" + dir.substring(dir.lastIndexOf('/') + 1) + "\"")) {
                return true;
            }
        }
        Set<String> names = new HashSet<>();
        names.add(callee.symbol.name());
        if (callee.symbol.container() != null) {
            names.add(callee.symbol.container());
        }
        for (String n : names) {
            if (Pattern.compile("\\b" + Pattern.quote(n) + "\\b").matcher(imports).find()) {
                return true;
            }
        }
        // Java/Kotlin: classes of the same package need no import
        if (("java".equals(caller.diff.language()) || "kotlin".equals(caller.diff.language())) && callee.symbol.container() != null) {
            return caller.mentions.computeIfAbsent(callee.symbol.container(), name -> {
                Pattern cls = Pattern.compile("\\b" + Pattern.quote(name) + "\\b");
                return caller.text.code.stream().anyMatch(l -> cls.matcher(l).find());
            });
        }
        return false;
    }

    private static String dirOf(String path) {
        return path.contains("/") ? path.substring(0, path.lastIndexOf('/')) : "";
    }

    /** 1-based line of the first reference to b in a's search lines; references on changed lines win. */
    private static Integer firstReference(Work a, Work b, List<Integer> lines) {
        return preferred(a, references(a, b, lines));
    }

    /** The reference an edge shows: the first one on a changed line of a, else the first one; null without any. */
    private static Integer preferred(Work a, List<Integer> references) {
        Set<Integer> changedNew = a.changed.stream().map(DiffLine::newLine).filter(n -> n != null).collect(Collectors.toSet());
        return references.stream().filter(changedNew::contains).findFirst()
                .orElse(references.isEmpty() ? null : references.get(0));
    }

    /**
     * 1-based lines of all references to b in a's search lines, ascending (a line counts once). A caller with the
     * name of the callee (update() delegating to service.update(), an overload) names it in its own declaration:
     * the name at that place is not a reference ({@link #ownDeclaration}).
     */
    private static List<Integer> references(Work a, Work b, List<Integer> lines) {
        String name = b.symbol.name();
        boolean generic = GENERIC.contains(name) || name.length() < 5;
        Pattern p = generic ? callPattern(name)
                : Pattern.compile("(?<![\\w$])<?" + Pattern.quote(name) + "(?![\\w$])(?!\\s*:(?!:))");
        int[] declaration = ownDeclaration(a, name);
        Set<Integer> found = new TreeSet<>();
        for (int idx : lines) {
            if (idx < 0 || idx >= a.ctx.text.code.size()) {
                continue;
            }
            int ln = idx + 1;
            if (b.ctx == a.ctx && ln == b.symbol.startLine()) {
                continue;
            }
            if (refers(p, a, idx, declaration)) {
                found.add(ln);
            }
        }
        return List.copyOf(found);
    }

    /** The line (0-based) matches the pattern somewhere else than at the caller's own declaration of the name. */
    private static boolean refers(Pattern p, Work a, int idx, int[] declaration) {
        Matcher m = p.matcher(a.ctx.text.code.get(idx));
        while (m.find()) {
            if (declaration == null || declaration[0] != idx || declaration[1] < m.start() || declaration[1] >= m.end()) {
                return true;
            }
        }
        return false;
    }

    private static final Pattern LEADING_ANNOTATIONS = Pattern.compile("^\\s*(?:@[\\w.]+(?:\\([^()]*\\))?\\s*)+");
    /** How many lines of a symbol are searched for its own name: annotations, modifiers and a return type on a line of its own. */
    private static final int MAX_DECLARATION_LINES = 12;

    /**
     * Where a function named like the callee writes that name in its own declaration: {line (0-based), column}, or
     * null when the caller has another name or does not write its name as code (a test case: its name is a title).
     * It is the first place the name stands on its own (not as a member, `x.name`) in the head of the symbol - the
     * lines after its annotations up to the one that opens the body. Found by position, whatever follows the name:
     * `update(…) {`, `save = (…) => {`, `archive: async (…) => {`, `fun update(…) =`.
     */
    private static int[] ownDeclaration(Work a, String name) {
        Symbol own = a.symbol;
        if (own == null || !own.isCallable() || own.isTestBlock() || !own.name().equals(name)) {
            return null;
        }
        Pattern bare = Pattern.compile("(?<![\\w$.])" + Pattern.quote(name) + "(?![\\w$])");
        List<String> code = a.ctx.text.code;
        int open = 0; // parentheses of an annotation that continues on the next line
        for (int idx = own.startLine() - 1; idx < own.endLine() && idx < code.size() && idx < own.startLine() - 1 + MAX_DECLARATION_LINES; idx++) {
            String line = code.get(idx);
            int from = 0;
            if (open == 0) {
                Matcher annotations = LEADING_ANNOTATIONS.matcher(line);
                from = annotations.find() ? annotations.end() : 0;
            }
            boolean annotation = open > 0 || line.strip().startsWith("@") && from == 0;
            if (annotation) {
                for (int i = 0; i < line.length(); i++) {
                    open += line.charAt(i) == '(' ? 1 : line.charAt(i) == ')' ? -1 : 0;
                }
                continue;
            }
            Matcher m = bare.matcher(line);
            if (m.find(from)) {
                return new int[]{idx, m.start()};
            }
            String rest = line.substring(from);
            if (rest.contains("{") || rest.contains("=>") || rest.contains(";")) {
                return null; // the head is over and did not name it
            }
        }
        return null;
    }

    /** The name followed by an argument list: `name(`, `name<T>(`. */
    private static Pattern callPattern(String name) {
        return Pattern.compile("(?<![\\w$])" + Pattern.quote(name) + "\\s*(?:<[^>]*>)?\\(");
    }

    /**
     * The lines of a that call b, for the order of the calls (FlowEdge.lines): of the references those with call
     * syntax - a line that only names b (a parameter or variable of the same name, a type) is not a call. Empty for
     * something that is not called (a constant, a type, a component in a template): it is used, not called again and
     * again, and the edge keeps the one line it shows.
     */
    private static List<Integer> callLines(Work a, Work b, List<Integer> references) {
        if (!b.symbol.isCallable() || "component".equals(b.symbol.kind())) {
            return List.of();
        }
        Pattern call = callPattern(b.symbol.name());
        int[] declaration = ownDeclaration(a, b.symbol.name());
        return references.stream().filter(ln -> refers(call, a, ln - 1, declaration)).toList();
    }

    // ------------------------------------------------------------------ flows

    /**
     * Callees referenced from more than this many changed places are shared utilities (a Button, `cn`,
     * a logger): they would glue unrelated flows together, so calls to them do not form flows.
     */
    private static final int HUB_LIMIT = 5;
    /**
     * In bigger connected groups (e.g. a whole new app in one PR) every entry point would reach almost
     * everything; there each function is shown in one flow only (the first entry point that reaches it).
     */
    private static final int MAX_OVERLAP_STEPS = 20;
    /** How deep tests are followed into the code (test -> a -> b -> c). */
    private static final int MAX_TEST_DEPTH = 4;

    /**
     * Every entry point (a changed function no other changed function calls) gets its own flow with all it
     * reaches. Functions reached from several entry points are therefore part of several flows (only in
     * groups up to MAX_OVERLAP_STEPS); cycles without an entry point start at the best candidate (layer heuristic).
     */
    private List<Flow> buildFlows(List<Work> works, List<FlowEdge> allEdges) {
        Map<String, Work> byId = new HashMap<>();
        works.forEach(w -> byId.put(w.id, w));
        // tests are linked to the code separately (see tests()); they never form flows
        List<FlowEdge> codeEdges = allEdges.stream()
                .filter(e -> !isTest(byId.get(e.from())) && !isTest(byId.get(e.to()))).toList();
        Map<String, Integer> callers = new HashMap<>();
        codeEdges.forEach(e -> callers.merge(e.to(), 1, Integer::sum));
        List<FlowEdge> edges = codeEdges.stream().filter(e -> callers.get(e.to()) <= HUB_LIMIT).toList();
        Map<String, String> parent = new HashMap<>();
        for (FlowEdge e : edges) {
            union(parent, e.from(), e.to());
        }
        Map<String, List<String>> components = new LinkedHashMap<>();
        for (Work w : works) {
            if (parent.containsKey(w.id)) {
                components.computeIfAbsent(find(parent, w.id), k -> new ArrayList<>()).add(w.id);
            }
        }

        List<Flow> flows = new ArrayList<>();
        for (List<String> members : components.values()) {
            boolean hasLogic = members.stream().anyMatch(id -> byId.get(id).category == null);
            if (members.size() < 2 || !hasLogic) {
                continue;
            }
            Set<String> memberSet = new HashSet<>(members);
            List<FlowEdge> flowEdges = edges.stream().filter(e -> memberSet.contains(e.from())).toList();
            Map<String, List<FlowEdge>> outgoing = new HashMap<>();
            Map<String, Integer> inDegree = new HashMap<>();
            for (FlowEdge e : flowEdges) {
                outgoing.computeIfAbsent(e.from(), k -> new ArrayList<>()).add(e);
                inDegree.merge(e.to(), 1, Integer::sum);
            }
            outgoing.values().forEach(l -> l.sort(Comparator.comparing(e -> e.line() == null ? 0 : e.line())));

            Comparator<String> entryOrder = Comparator.comparingInt((String id) -> layer(byId.get(id)))
                    .thenComparing(id -> byId.get(id).label());
            List<String> candidates = new ArrayList<>(members);
            candidates.sort(Comparator.comparingInt((String id) -> inDegree.getOrDefault(id, 0) == 0 ? 0 : 1).thenComparing(entryOrder));

            Set<String> covered = new HashSet<>();
            boolean overlap = members.size() <= MAX_OVERLAP_STEPS;
            for (String start : candidates) {
                if (covered.contains(start)) {
                    continue;
                }
                List<FlowStep> steps = new ArrayList<>();
                visit(start, null, 0, outgoing, overlap ? new HashSet<>() : covered, steps);
                steps.forEach(st -> covered.add(st.segmentId()));
                addFlow(flows, steps, flowEdges, byId);
            }
        }
        flows.sort(Comparator.comparingInt((Flow f) -> -f.steps().size()));
        List<Flow> renumbered = new ArrayList<>();
        for (int i = 0; i < flows.size(); i++) {
            Flow f = flows.get(i);
            renumbered.add(new Flow("flow-" + (i + 1), f.title(), f.steps(), f.edges()));
        }
        return renumbered;
    }

    private static void addFlow(List<Flow> flows, List<FlowStep> steps, List<FlowEdge> edges, Map<String, Work> byId) {
        boolean hasLogic = steps.stream().anyMatch(s -> byId.get(s.segmentId()).category == null);
        if (steps.size() < 2 || !hasLogic) {
            return;
        }
        Set<String> ids = steps.stream().map(FlowStep::segmentId).collect(Collectors.toSet());
        List<FlowEdge> own = edges.stream().filter(e -> ids.contains(e.from()) && ids.contains(e.to())).toList();
        flows.add(new Flow("flow-" + (flows.size() + 1), flowTitle(steps, byId), List.copyOf(steps), own));
    }

    private static void visit(String id, String parentId, int depth, Map<String, List<FlowEdge>> outgoing,
                              Set<String> visited, List<FlowStep> steps) {
        visited.add(id);
        steps.add(new FlowStep(id, steps.size() + 1, depth, parentId));
        for (FlowEdge e : outgoing.getOrDefault(id, List.of())) {
            if (!visited.contains(e.to())) {
                visit(e.to(), id, depth + 1, outgoing, visited, steps);
            }
        }
    }

    private static String flowTitle(List<FlowStep> steps, Map<String, Work> byId) {
        List<String> chain = new ArrayList<>();
        String current = steps.getFirst().segmentId();
        chain.add(shortName(byId.get(current)));
        while (chain.size() < 4) {
            String cur = current;
            FlowStep next = steps.stream().filter(s -> cur.equals(s.parentSegmentId())).findFirst().orElse(null);
            if (next == null) {
                break;
            }
            chain.add(shortName(byId.get(next.segmentId())));
            current = next.segmentId();
        }
        String title = String.join(" → ", chain);
        int rest = steps.size() - chain.size();
        String trigger = byId.get(steps.getFirst().segmentId()).trigger;
        title = trigger != null ? trigger + ": " + title : title;
        return rest > 0 ? title + " (+" + rest + ")" : title;
    }

    private static String shortName(Work w) {
        return w.symbol != null ? w.symbol.name() : w.label();
    }

    private static int layer(Work w) {
        String path = w.file.path();
        if (ENTRY_LAYER.matcher(path).find() || (w.symbol != null && "component".equals(w.symbol.kind()))) {
            return 0;
        }
        return DEEP_LAYER.matcher(path).find() ? 2 : 1;
    }

    private static String find(Map<String, String> parent, String x) {
        parent.putIfAbsent(x, x);
        String p = parent.get(x);
        if (!p.equals(x)) {
            p = find(parent, p);
            parent.put(x, p);
        }
        return p;
    }

    private static void union(Map<String, String> parent, String a, String b) {
        String ra = find(parent, a), rb = find(parent, b);
        if (!ra.equals(rb)) {
            parent.put(rb, ra);
        }
    }

    // ------------------------------------------------------------------ tests

    /** Test file name -> name of the unit under test: PlayerResourceTest.java -> PlayerResource, a.service.spec.ts -> a.service. */
    static final Pattern TEST_FILE = Pattern.compile(
            "^(?:test_(.+)\\.py|(.+?)(?:\\.(?:spec|test|e2e-spec|e2e)\\.[A-Za-z]+|_test\\.[A-Za-z]+|(?:Tests?|IT|Spec)\\.(?:java|kt|cs|groovy)))$");

    /**
     * HTTP-Tests ({@link HttpTests}): the finder, the changed endpoints by segment id (in segment order), the class-level
     * paths of the changed classes by simple name (for @TestHTTPEndpoint) and, filled by the test walk, the requests
     * each test expects (by test id: segment id of a changed test, "e1" … of an existing one).
     */
    private record HttpLinks(HttpTests tests, Map<String, List<TestRules.EndpointAt>> endpoints, Map<String, String> classPaths,
                             Map<String, List<HttpTests.Expectation>> expectations) {
    }

    /**
     * What a test does over HTTP: edges test -> changed endpoint (kind http, via = the endpoint, line = where the test
     * sends the request or calls the helper that does), the requests behind them, and the requests it expects.
     */
    private record HttpReach(List<FlowEdge> edges, List<HttpTests.Request> hits, List<HttpTests.Expectation> expectations) {
    }

    /**
     * The HTTP reach of one test: every real request (not with a mocked HTTP backend) goes to the changed endpoints it
     * matches - the most exact ones ({@link Http#exactness}) when several do.
     */
    private static HttpReach httpReach(String testId, CodeText text, List<Symbol> symbols, Symbol test, String surroundings,
                                       List<String> mocks, HttpLinks links) {
        HttpTests.Found found = links.tests().find(text, symbols, test, surroundings, links.classPaths());
        if (found.requests().isEmpty() || mocks.contains(TestProfiles.HTTP) || links.endpoints().isEmpty()) {
            return new HttpReach(List.of(), List.of(), found.expectations());
        }
        List<FlowEdge> edges = new ArrayList<>();
        List<HttpTests.Request> hits = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (HttpTests.Request r : found.requests()) {
            int best = -1;
            List<Map.Entry<String, TestRules.EndpointAt>> matches = new ArrayList<>();
            for (Map.Entry<String, List<TestRules.EndpointAt>> e : links.endpoints().entrySet()) {
                for (TestRules.EndpointAt at : e.getValue()) {
                    if (!Http.matches(r.call(), at.endpoint())) {
                        continue;
                    }
                    int exactness = Http.exactness(r.call(), at.endpoint());
                    if (exactness > best) {
                        best = exactness;
                        matches.clear();
                    }
                    if (exactness == best) {
                        matches.add(Map.entry(e.getKey(), at));
                    }
                }
            }
            if (!matches.isEmpty()) {
                hits.add(r);
            }
            for (Map.Entry<String, TestRules.EndpointAt> m : matches) {
                String label = m.getValue().endpoint().label();
                if (seen.add(m.getKey() + " " + label)) {
                    edges.add(new FlowEdge(testId, m.getKey(), r.call().line(), label, "http"));
                }
            }
        }
        return new HttpReach(List.copyOf(edges), List.copyOf(hits), found.expectations());
    }

    /** The class-level endpoint paths (JAX-RS @Path, Spring @RequestMapping) of the changed classes, by simple name. */
    private static Map<String, String> classPaths(List<Work> works) {
        Map<String, String> result = new HashMap<>();
        Set<FileCtx> files = new LinkedHashSet<>();
        works.stream().filter(w -> w.ctx != null && !isTest(w)).forEach(w -> files.add(w.ctx));
        for (FileCtx ctx : files) {
            for (Symbol s : ctx.symbols) {
                if ("class".equals(s.kind())) {
                    String base = Http.classBase(head(ctx.text.lines, s));
                    if (base != null) {
                        result.putIfAbsent(s.name(), base);
                    }
                }
            }
        }
        return result;
    }

    /**
     * The names whose call arguments are a test's inputs (Fall- und Effekt-Abgleich): the code it calls directly and
     * the same-file helpers that send its requests to changed endpoints (`putJerseyNumber(23)`).
     */
    private static List<String> inputTargets(List<String> targets, HttpReach http) {
        Set<String> names = new LinkedHashSet<>(targets);
        http.hits().stream().map(HttpTests.Request::helper).filter(Objects::nonNull).forEach(names::add);
        return List.copyOf(names);
    }

    /** The case evidence of a test, with the literals of the requests its helpers send to changed endpoints. */
    private static CaseChecks.Evidence evidence(CaseChecks caseChecks, String id, CodeText text, List<Symbol> symbols, Symbol test,
                                                List<String> targets, HttpReach http) {
        CaseChecks.Evidence e = caseChecks.evidence(id, text, symbols, test, inputTargets(targets, http));
        http.hits().stream().map(HttpTests.Request::inputs).distinct().forEach(inputs -> CaseChecks.addNumbers(e, inputs));
        return e;
    }

    /**
     * For every changed test case: the changed code it reaches through calls (directly, via test helpers, or
     * indirectly via other changed code) and over HTTP (HTTP-Tests), the components it is about (naming convention +
     * called code) and its profile (Test-Steckbrief, {@link TestProfiles}).
     */
    private static List<TestInfo> tests(List<Work> works, List<FlowEdge> edges, List<DiffFile> files, TestProfiles profiles,
                                        List<MockWarning> warnings, CaseChecks caseChecks, Map<String, CaseChecks.Evidence> evidence,
                                        Map<String, TestRules.TestFacts> facts, TestSmells smells, Set<String> newTests,
                                        HttpLinks links) {
        Map<String, Work> byId = new HashMap<>();
        works.forEach(w -> byId.put(w.id, w));
        Map<String, List<FlowEdge>> outgoing = testGraph(edges);

        List<TestInfo> result = new ArrayList<>();
        for (Work t : works) {
            if (!isTestCase(t)) {
                continue;
            }
            String unit = unitOf(t.file.path());
            String surroundings = TestProfiles.surroundingsOf(t.ctx.text, t.ctx.symbols, t.symbol);
            List<String> mocks = profiles.mocks(surroundings, unit);
            HttpReach http = httpReach(t.id, t.ctx.text, t.ctx.symbols, t.symbol, surroundings, mocks, links);
            if (!http.expectations().isEmpty()) {
                links.expectations().put(t.id, http.expectations());
            }
            Map<String, TestCoverage> covers = reach(t.id, outgoing, http.edges(), byId, mocks);
            warnings.addAll(mockWarnings(t.id, t.symbol.displayName(), t.file.path(), mocks, surroundings, works, profiles));
            List<TestSubject> subjects = subjects(t, covers.values(), byId, files);
            List<String> targets = targets(covers.values(), subjects, byId);
            TestProfile profile = profiles.profile(t.file.path(), t.ctx.text, t.ctx.symbols, t.symbol, targets, unit);
            Set<String> realKeys = new HashSet<>();
            List<TestSmells.MockedMember> mockedMembers = new ArrayList<>();
            for (TestCoverage c : covers.values()) {
                Work w = byId.get(c.segmentId());
                if (w == null || !c.direct()) {
                    continue;
                }
                if (!c.mocked()) {
                    realKeys.addAll(ownerKeys(w));
                } else if (w.symbol != null && w.symbol.name() != null) {
                    mockedMembers.add(new TestSmells.MockedMember(w.symbol.name(), ownerKeys(w)));
                }
            }
            List<TestSmell> testSmells = smells.detect(new TestSmells.Input(t.ctx.text, t.ctx.symbols, t.symbol, profile, unit,
                    realKeys, mockedMembers, newTests.contains(t.id)));
            result.add(new TestInfo(t.id, t.symbol.displayName(), t.file.path(), subjects, List.copyOf(covers.values()), profile,
                    testSmells));
            CaseChecks.Evidence e = evidence(caseChecks, t.id, t.ctx.text, t.ctx.symbols, t.symbol, targets, http);
            evidence.put(t.id, e);
            facts.put(t.id, testFacts(t.id, t.ctx.text, t.ctx.symbols, t.symbol, e, profile, http, covers));
        }
        return result;
    }

    /**
     * The call graph tests follow: by caller, in call order, without the http edges between client and endpoint (a
     * client's request runs against a mocked backend in its tests); a test's own requests are added per test
     * ({@link #httpReach}).
     */
    private static Map<String, List<FlowEdge>> testGraph(List<FlowEdge> edges) {
        Map<String, List<FlowEdge>> outgoing = new HashMap<>();
        for (FlowEdge e : edges) {
            if (!"http".equals(e.kind())) {
                outgoing.computeIfAbsent(e.from(), k -> new ArrayList<>()).add(e);
            }
        }
        outgoing.values().forEach(l -> l.sort(Comparator.comparing(e -> e.line() == null ? 0 : e.line())));
        return outgoing;
    }

    /**
     * The changed code a test case reaches (breadth first, up to MAX_TEST_DEPTH calls): direct when called by the test
     * or its helpers (test helpers and fixtures are transparent) or hit by one of its HTTP requests (httpEdges, see
     * {@link #httpReach}), else indirect via the changed segment it came through. line: the call site in the test that
     * leads there. Code of a collaborator in mocks (TestProfile.mocks) is reached only as a mock: it is recorded as
     * mocked and the walk does not continue into what it calls (Mock-Grenze).
     */
    private static Map<String, TestCoverage> reach(String testId, Map<String, List<FlowEdge>> outgoing, List<FlowEdge> httpEdges,
                                                   Map<String, Work> byId, List<String> mocks) {
        Set<String> mockKeys = MockBoundaries.keys(mocks);
        record Hop(String id, String via, Integer line, int depth, boolean http, String endpoint) {
        }
        Map<String, TestCoverage> covers = new LinkedHashMap<>();
        Deque<Hop> queue = new ArrayDeque<>();
        List<FlowEdge> first = new ArrayList<>(outgoing.getOrDefault(testId, List.of()));
        first.addAll(httpEdges);
        first.sort(Comparator.comparing(e -> e.line() == null ? 0 : e.line()));
        for (FlowEdge e : first) {
            boolean http = "http".equals(e.kind());
            queue.add(new Hop(e.to(), null, e.line(), 1, http, http ? e.via() : null));
        }
        Set<String> seen = new HashSet<>(Set.of(testId));
        while (!queue.isEmpty()) {
            Hop h = queue.poll();
            Work w = byId.get(h.id());
            if (w == null || !seen.add(h.id()) || isTestCase(w)) {
                continue;
            }
            String via = h.via();
            if (!isTest(w)) { // a test helper/fixture is transparent
                boolean mocked = !mockKeys.isEmpty() && ownerKeys(w).stream().anyMatch(mockKeys::contains);
                covers.put(w.id, new TestCoverage(w.id, h.via() == null, h.via(), h.line(), mocked, h.http(),
                        h.via() == null ? h.endpoint() : null));
                if (mocked) {
                    continue; // the test runs the mock, neither this code nor what it calls
                }
                via = w.id;
            }
            if (h.depth() < MAX_TEST_DEPTH) {
                for (FlowEdge e : outgoing.getOrDefault(w.id, List.of())) {
                    queue.add(new Hop(e.to(), via, h.line(), h.depth() + 1, h.http(), h.endpoint()));
                }
            }
        }
        return covers;
    }

    /** The names a segment's collaborator can be mocked by (see {@link MockBoundaries#ownerKeys}). */
    private static Set<String> ownerKeys(Work w) {
        return MockBoundaries.ownerKeys(w.file.path(), w.symbol == null ? null : w.symbol.kind(),
                w.symbol == null ? null : w.symbol.name(), w.symbol == null ? null : w.symbol.container());
    }

    /**
     * Mock warnings of one test: for every changed callable segment (no test code) of a collaborator the test mocks,
     * the place where the test stubs or references that member by name (rules "testProfile.mockMembers"); a mocked
     * collaborator whose changed members the test does not name gives no warning.
     */
    private static List<MockWarning> mockWarnings(String testId, String testName, String path, List<String> mocks,
                                                  String surroundings, List<Work> works, TestProfiles profiles) {
        if (MockBoundaries.keys(mocks).isEmpty()) {
            return List.of();
        }
        List<MockWarning> result = new ArrayList<>();
        for (Work w : works) {
            if (!"symbol".equals(w.kind) || isTest(w) || !w.symbol.isCallable() || w.symbol.isTestBlock()
                    || NOT_CALLED.contains(w.symbol.name())) {
                continue;
            }
            String collaborator = MockBoundaries.mockedBy(mocks, ownerKeys(w));
            if (collaborator == null) {
                continue;
            }
            Integer line = profiles.mockedMemberLine(surroundings, w.symbol.name());
            if (line != null) {
                result.add(new MockWarning(testId, testName, path, line, w.id, w.symbol.name(), collaborator));
            }
        }
        return result;
    }

    /** Changed code that can be called: functions, methods, components and constants with a specific enough name. */
    private static List<Work> callees(List<Work> works) {
        return works.stream()
                .filter(w -> "symbol".equals(w.kind) && (w.symbol.isCallable() || "const".equals(w.symbol.kind()))
                        && !w.symbol.isTestBlock() && w.symbol.name().length() >= 3 && !NOT_CALLED.contains(w.symbol.name()))
                .toList();
    }

    /**
     * Bestehende Tests: the test cases of existing, unchanged test files (selected by {@link RelatedTests}, loaded by
     * the caller) linked to the changed code like changed tests - the same name references with import evidence, the
     * same call graph, the same HTTP reach (HTTP-Tests), the same depth. Their helper functions are transparent like
     * test helpers. They are no segments; only test cases that reach changed code are returned, by path and line, with
     * ids e1, e2, ….
     */
    private static List<ExistingTest> existingTests(List<Work> works, List<FlowEdge> edges, Model.RelatedTests related,
                                                    Map<String, String> relatedSources, TestProfiles profiles,
                                                    List<MockWarning> warnings, CaseChecks caseChecks,
                                                    Map<String, CaseChecks.Evidence> evidence,
                                                    Map<String, TestRules.TestFacts> facts, HttpLinks links) {
        if (related == null || related.files() == null || relatedSources == null || relatedSources.isEmpty()) {
            return List.of();
        }
        Map<String, Work> byId = new HashMap<>();
        works.forEach(w -> byId.put(w.id, w));
        Map<String, List<FlowEdge>> graph = new HashMap<>(testGraph(edges));
        List<Work> callees = callees(works);
        record Found(Work test, String reason, Map<String, TestCoverage> covers, List<String> mocks, String surroundings,
                     HttpReach http) {
        }
        List<Found> found = new ArrayList<>();
        for (RelatedTestFile f : related.files()) {
            String source = relatedSources.get(f.path());
            if (source == null) {
                continue;
            }
            FileCtx ctx = new FileCtx();
            ctx.diff = new DiffFile(f.path(), null, "unchanged", 0, 0, Languages.of(f.path()), false, List.of());
            ctx.source = source;
            ctx.text = CodeText.of(source);
            ctx.symbols = SymbolExtractor.extract(ctx.text, f.path());
            indexImports(ctx);
            List<Work> nodes = new ArrayList<>();
            for (Symbol s : ctx.symbols) {
                boolean testCase = "test".equals(s.kind());
                boolean helper = s.isCallable() && !s.isTestBlock() && s.name().length() >= 3 && !NOT_CALLED.contains(s.name());
                if (testCase || helper) {
                    Work n = new Work();
                    n.id = "related:" + f.path() + ":" + s.startLine() + ":" + s.name();
                    n.kind = "symbol";
                    n.file = ctx.diff;
                    n.ctx = ctx;
                    n.symbol = s;
                    n.category = "tests";
                    nodes.add(n);
                    byId.put(n.id, n);
                }
            }
            List<Work> helpers = nodes.stream().filter(n -> !n.symbol.isTestBlock()).toList();
            for (Work a : nodes) {
                List<Integer> lines = searchLinesOf(a, nodes);
                List<FlowEdge> out = new ArrayList<>();
                for (Work b : helpers) { // helpers of the same file need no import
                    if (a == b || (b.symbol.contains(a.symbol.startLine()) && b.symbol.span() >= a.symbol.span())) {
                        continue;
                    }
                    Integer line = firstReference(a, b, lines);
                    if (line != null) {
                        out.add(new FlowEdge(a.id, b.id, line, b.symbol.name(), "call"));
                    }
                }
                for (Work b : callees) {
                    if (!importsFrom(ctx, b)) {
                        continue;
                    }
                    Integer line = firstReference(a, b, lines);
                    if (line != null) {
                        out.add(new FlowEdge(a.id, b.id, line, b.symbol.name(), "call"));
                    }
                }
                out.sort(Comparator.comparing(e -> e.line() == null ? 0 : e.line()));
                graph.put(a.id, out);
            }
            for (Work t : nodes) {
                if (t.symbol.kind().equals("test")) {
                    String surroundings = TestProfiles.surroundingsOf(ctx.text, ctx.symbols, t.symbol);
                    List<String> mocks = profiles.mocks(surroundings, unitOf(f.path()));
                    HttpReach http = httpReach(t.id, ctx.text, ctx.symbols, t.symbol, surroundings, mocks, links);
                    Map<String, TestCoverage> covers = reach(t.id, graph, http.edges(), byId, mocks);
                    if (!covers.isEmpty()) {
                        found.add(new Found(t, f.reason(), covers, mocks, surroundings, http));
                    }
                }
            }
        }
        found.sort(Comparator.comparing((Found x) -> x.test().file.path()).thenComparingInt(x -> x.test().symbol.startLine()));
        List<ExistingTest> result = new ArrayList<>();
        for (Found x : found) {
            Work t = x.test();
            List<String> targets = targets(x.covers().values(), List.of(), byId);
            String unit = unitOf(t.file.path());
            if (targets.isEmpty() && unit != null) {
                targets = List.of(unit);
            }
            String id = "e" + (result.size() + 1);
            TestProfile profile = profiles.profile(t.file.path(), t.ctx.text, t.ctx.symbols, t.symbol, targets, unit);
            result.add(new ExistingTest(id, t.file.path(), t.symbol.displayName(), t.symbol.startLine(),
                    x.reason(), List.copyOf(x.covers().values()), profile));
            CaseChecks.Evidence e = evidence(caseChecks, id, t.ctx.text, t.ctx.symbols, t.symbol, targets, x.http());
            evidence.put(id, e);
            facts.put(id, testFacts(id, t.ctx.text, t.ctx.symbols, t.symbol, e, profile, x.http(), x.covers()));
            if (!x.http().expectations().isEmpty()) {
                links.expectations().put(id, x.http().expectations());
            }
            warnings.addAll(mockWarnings(id, t.symbol.displayName(), t.file.path(), x.mocks(), x.surroundings(), works, profiles));
        }
        return result;
    }

    /**
     * What a test shows for the Erwartungs-Regeln: its code with the same-file helpers it calls, its assertions (from
     * the case evidence), scenario and level (from its profile), the endpoints it reaches directly over HTTP for real.
     */
    private static TestRules.TestFacts testFacts(String id, CodeText text, List<Symbol> symbols, Symbol test,
                                                 CaseChecks.Evidence evidence, TestProfile profile, HttpReach http,
                                                 Map<String, TestCoverage> covers) {
        String code = evidence.text() + "\n" + helperCode(text, symbols, test, evidence.text());
        Map<String, Set<String>> endpoints = new HashMap<>();
        for (FlowEdge e : http.edges()) {
            TestCoverage c = covers.get(e.to());
            if (c != null && c.http() && c.direct() && !c.mocked()) {
                endpoints.computeIfAbsent(e.to(), k -> new LinkedHashSet<>()).add(e.via());
            }
        }
        return new TestRules.TestFacts(id, code, evidence.assertions(), profile.scenario(), profile.level(), endpoints);
    }

    /**
     * The code (comments blanked, strings kept) of the same-file helpers a test calls by name - functions and methods
     * that are no test blocks, also those the helpers call, up to three calls deep.
     */
    private static String helperCode(CodeText text, List<Symbol> symbols, Symbol test, String testCode) {
        StringBuilder sb = new StringBuilder();
        Set<Symbol> seen = new HashSet<>();
        List<String> frontier = List.of(testCode);
        for (int depth = 0; depth < 3 && !frontier.isEmpty(); depth++) {
            List<String> next = new ArrayList<>();
            for (Symbol s : symbols) {
                if (s == test || !s.isCallable() || s.isTestBlock() || s.contains(test.startLine()) || seen.contains(s)) {
                    continue;
                }
                Pattern call = Pattern.compile("(?<![\\w$])" + Pattern.quote(s.name()) + "\\s*(?:<[^<>()]*>)?\\s*\\(");
                if (frontier.stream().anyMatch(f -> call.matcher(f).find())) {
                    seen.add(s);
                    String code = String.join("\n", text.visible.subList(s.startLine() - 1, Math.min(s.endLine(), text.visible.size())));
                    next.add(code);
                    sb.append(code).append('\n');
                }
            }
            frontier = next;
        }
        return sb.toString();
    }

    /**
     * The HTTP endpoints changed segments declare (Erwartungs-Regeln), by segment id: a method or function with
     * JAX-RS/Spring annotations or a Next.js route (at its declaration line), a method of a class implementing a
     * generated "...Api" interface named like an operation of the API contract, and the Express/Go route registrations in
     * the segment's lines. added: that line is added in the PR (a new endpoint).
     */
    private static Map<String, List<TestRules.EndpointAt>> endpoints(List<Work> works, List<ApiOperation> operations) {
        Map<String, List<ApiOperation>> byOperationId = new HashMap<>();
        operations.forEach(o -> byOperationId.computeIfAbsent(o.operationId(), k -> new ArrayList<>()).add(o));
        Map<String, List<TestRules.EndpointAt>> result = new LinkedHashMap<>();
        for (Work w : works) {
            if (w.ctx == null || isTest(w)) {
                continue;
            }
            Set<Integer> added = w.changed.stream().filter(l -> "add".equals(l.type()) && l.newLine() != null)
                    .map(DiffLine::newLine).collect(Collectors.toSet());
            List<TestRules.EndpointAt> found = new ArrayList<>();
            List<String> raw = w.ctx.text.lines;
            if (w.symbol != null && w.symbol.isCallable() && !w.symbol.isTestBlock()) {
                int decl = Expectations.declarationLine(w.ctx.text, w.symbol);
                Http.Endpoint e = Http.annotated(head(raw, w.symbol), classHead(w));
                if (e == null) {
                    e = Http.fileRoute(w.file.path(), w.symbol.name());
                }
                if (e != null) {
                    found.add(new TestRules.EndpointAt(e, decl, added.contains(decl)));
                } else if (!w.frontend && IMPLEMENTS_API.matcher(String.join(" ", classHead(w))).find()) {
                    for (ApiOperation o : byOperationId.getOrDefault(w.symbol.name(), List.of())) {
                        found.add(new TestRules.EndpointAt(new Http.Endpoint(o.method(), o.path()), decl, added.contains(decl)));
                    }
                }
            }
            int from = w.symbol != null ? w.symbol.startLine() : w.anchors.values().stream().min(Integer::compare).orElse(1);
            int to = w.symbol != null ? w.symbol.endLine() : w.anchors.values().stream().max(Integer::compare).orElse(1);
            for (int li = Math.max(1, from); li <= Math.min(to, raw.size()); li++) {
                for (Http.Endpoint e : Http.registered(raw.get(li - 1))) {
                    found.add(new TestRules.EndpointAt(e, li, added.contains(li)));
                }
            }
            if (!found.isEmpty()) {
                result.put(w.id, List.copyOf(found));
            }
        }
        return result;
    }

    /**
     * The changed segments the Erwartungs-Regeln look at - everything with source outside the tests (functions,
     * classes, module code) - with the tests that reach them for real (changed tests first, then existing ones; a mock
     * of it does not count). A class or type also takes the tests reaching its changed members.
     */
    private static List<TestRules.Target> ruleTargets(List<Work> works, List<TestInfo> tests, List<ExistingTest> existingTests,
                                                      Map<String, List<TestRules.EndpointAt>> endpoints) {
        Map<String, List<String>> reaching = new HashMap<>();
        for (TestInfo t : tests) {
            t.covers().stream().filter(c -> !c.mocked())
                    .forEach(c -> reaching.computeIfAbsent(c.segmentId(), k -> new ArrayList<>()).add(t.segmentId()));
        }
        for (ExistingTest t : existingTests) {
            t.covers().stream().filter(c -> !c.mocked())
                    .forEach(c -> reaching.computeIfAbsent(c.segmentId(), k -> new ArrayList<>()).add(t.id()));
        }
        List<TestRules.Target> result = new ArrayList<>();
        for (Work w : works) {
            if (w.ctx == null || isTest(w) || (w.symbol != null && w.symbol.isTestBlock())) {
                continue;
            }
            Set<String> r = new LinkedHashSet<>(reaching.getOrDefault(w.id, List.of()));
            if (w.symbol != null && !w.symbol.isCallable()) {
                for (Work m : works) {
                    if (m != w && m.symbol != null && m.file == w.file && w.symbol.contains(m.symbol.startLine())
                            && m.symbol.span() < w.symbol.span()) {
                        r.addAll(reaching.getOrDefault(m.id, List.of()));
                    }
                }
            }
            List<String> raw = w.ctx.text.lines;
            int from = w.symbol != null ? w.symbol.startLine() : w.anchors.values().stream().min(Integer::compare).orElse(1);
            int to = w.symbol != null ? w.symbol.endLine() : w.anchors.values().stream().max(Integer::compare).orElse(1);
            from = Math.max(1, Math.min(from, raw.size()));
            List<String> lines = raw.subList(from - 1, Math.max(from - 1, Math.min(to, raw.size())));
            List<TestRules.ChangedLine> changed = w.changed.stream()
                    .map(l -> new TestRules.ChangedLine(l.newLine() != null ? l.newLine() : w.anchors.getOrDefault(l, 0), l.text()))
                    .toList();
            result.add(new TestRules.Target(w.id, w.file.path(), w.symbol != null ? w.symbol.kind() : w.kind, from, lines,
                    changed, w.concerns, endpoints.getOrDefault(w.id, List.of()), List.copyOf(r)));
        }
        return result;
    }

    /**
     * Coverage from the code's side: for every testable changed function, which changed tests reach it directly or
     * only via other changed code, which existing tests reach it, how many branches it has and how much of it changed
     * (see Model.CodeCoverage). A reach of a mock of it (TestCoverage.mocked) does not cover it; such tests are listed
     * as mockedTests. findings: what the code can do against what the reaching tests check ({@link CaseChecks});
     * boundaries (out): the boundaries found per segment, for the Fallmatrix.
     */
    private List<CodeCoverage> coverage(List<Work> works, List<TestInfo> tests, List<ExistingTest> existingTests,
                                        CaseChecks caseChecks, Map<String, CaseChecks.Evidence> evidence,
                                        Map<String, List<CaseChecks.Boundary>> boundaries) {
        Map<String, List<String>> direct = new HashMap<>();
        Map<String, List<String>> indirect = new HashMap<>();
        Map<String, List<String>> existing = new HashMap<>();
        Map<String, List<String>> mocked = new HashMap<>(); // only a mock of it is reached: not covered
        for (TestInfo t : tests) {
            for (TestCoverage c : t.covers()) {
                (c.mocked() ? mocked : c.direct() ? direct : indirect)
                        .computeIfAbsent(c.segmentId(), k -> new ArrayList<>()).add(t.segmentId());
            }
        }
        for (ExistingTest t : existingTests) {
            for (TestCoverage c : t.covers()) {
                (c.mocked() ? mocked : existing).computeIfAbsent(c.segmentId(), k -> new ArrayList<>()).add(t.id());
            }
        }
        List<CodeCoverage> result = new ArrayList<>();
        for (Work w : works) {
            int changed = (int) w.changed.stream().filter(l -> !Rules.isTrivial(l.text())).count();
            if (!needsTests(w) || changed == 0) {
                continue;
            }
            List<String> d = direct.getOrDefault(w.id, List.of());
            List<String> i = indirect.getOrDefault(w.id, List.of());
            List<String> e = existing.getOrDefault(w.id, List.of());
            String status = !d.isEmpty() ? Coverage.DIRECT : !i.isEmpty() ? Coverage.INDIRECT
                    : !e.isEmpty() ? Coverage.EXISTING : Coverage.NONE;
            List<String> code = w.ctx.text.code;
            List<String> body = code.subList(Math.min(w.symbol.startLine() - 1, code.size()), Math.min(w.symbol.endLine(), code.size()));
            if (Coverage.isTrivialAccessor(body)) {
                continue; // getters and setters: nothing a test would have to prove
            }
            int branches = Coverage.branches(body);
            List<String> reaching = new ArrayList<>(d);
            reaching.addAll(i);
            reaching.addAll(e);
            List<Integer> own = w.changed.stream().filter(l -> l.newLine() != null && "add".equals(l.type())).map(DiffLine::newLine).toList();
            CaseChecks.Result checks = caseChecks.findings(w.ctx.text, w.symbol, own, branches, reaching, evidence);
            boundaries.put(w.id, checks.boundaries());
            result.add(new CodeCoverage(w.id, status, List.copyOf(d), List.copyOf(i), branches, changed, Coverage.risk(changed, branches),
                    List.copyOf(e), List.copyOf(mocked.getOrDefault(w.id, List.of())), checks.findings()));
        }
        result.sort(Coverage.ORDER);
        return result;
    }

    /**
     * Testable changed logic: a changed function/method/component (no test case, no test helper) whose main
     * category needs tests (rules: needsTests). Framework hooks (NOT_CALLED: constructor, ngOnInit, render, ...)
     * are left out - no test calls them by name, so the static view could only ever report them as untested.
     * Trivial accessors (getters/setters, {@link Coverage#isTrivialAccessor}) are dropped in coverage().
     */
    private boolean needsTests(Work w) {
        return "symbol".equals(w.kind) && w.ctx != null && w.symbol.isCallable() && !w.symbol.isTestBlock() && !isTest(w)
                && !NOT_CALLED.contains(w.symbol.name()) && rules.needsTests(w.category);
    }

    private static List<TestSubject> subjects(Work test, Iterable<TestCoverage> covers, Map<String, Work> byId, List<DiffFile> files) {
        Map<String, TestSubject> subjects = new LinkedHashMap<>();
        String path = test.file.path();
        Matcher m = TEST_FILE.matcher(path.substring(path.lastIndexOf('/') + 1));
        if (m.matches()) {
            String unit = m.group(1) != null ? m.group(1) : m.group(2);
            DiffFile match = files.stream()
                    .filter(f -> !f.path().equals(path) && !TEST_FILE.matcher(fileName(f.path())).matches()
                            && stemOf(fileName(f.path())).equals(unit))
                    // player-view.spec.ts -> player-view.ts rather than player-view.scss
                    .max(Comparator.comparing((DiffFile f) -> f.language().equals(test.file.language()))
                            .thenComparing(f -> Languages.hasSymbols(f.language()))
                            .thenComparingInt(f -> commonPrefix(f.path(), path)))
                    .orElse(null);
            String name = match == null ? unit : fileName(match.path());
            subjects.put(match == null ? "?" + unit : match.path(), new TestSubject(name, match == null ? null : match.path(), match != null, "name"));
        }
        for (TestCoverage c : covers) {
            Work w = byId.get(c.segmentId());
            if (!c.direct() || c.mocked() || subjects.containsKey(w.file.path())) {
                continue;
            }
            String name = w.symbol != null && w.symbol.container() != null ? w.symbol.container() : fileName(w.file.path());
            subjects.put(w.file.path(), new TestSubject(name, w.file.path(), true, c.http() ? "http" : "call"));
        }
        return List.copyOf(subjects.values());
    }

    /** The unit under test from the test file name (PlayerResourceTest.java -> PlayerResource), or null. */
    static String unitOf(String path) {
        Matcher m = TEST_FILE.matcher(fileName(path));
        return !m.matches() ? null : m.group(1) != null ? m.group(1) : m.group(2);
    }

    /**
     * What a test exercises, short: the names of the changed code it calls directly (call order, no duplicates; not
     * what it only reaches as a mock), else the component from the test file name.
     */
    private static List<String> targets(Collection<TestCoverage> covers, List<TestSubject> subjects, Map<String, Work> byId) {
        Set<String> names = new LinkedHashSet<>();
        for (TestCoverage c : covers) {
            Work w = byId.get(c.segmentId());
            if (c.direct() && !c.mocked() && w != null) {
                names.add(w.symbol != null ? w.symbol.name() : fileName(w.file.path()));
            }
        }
        if (names.isEmpty()) {
            subjects.stream().filter(s -> "name".equals(s.how())).forEach(s -> names.add(s.path() == null ? s.name() : stemOf(s.name())));
        }
        return List.copyOf(names);
    }

    private static String fileName(String path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    private static String stemOf(String fileName) {
        return fileName.contains(".") ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;
    }

    private static int commonPrefix(String a, String b) {
        int i = 0;
        while (i < a.length() && i < b.length() && a.charAt(i) == b.charAt(i)) {
            i++;
        }
        return i;
    }

    // ------------------------------------------------------------------ output

    private Segment toSegment(Work w, List<String> places, List<String> testedBy, Signature signature) {
        Set<String> own = w.changed.stream().map(DiffLine::key).collect(Collectors.toCollection(LinkedHashSet::new));
        List<DisplayLine> lines;
        if (w.ctx == null) {
            lines = new ArrayList<>();
            for (DiffLine l : w.hunk.lines()) {
                lines.add(new DisplayLine(l.type(), l.oldLine(), l.newLine(), l.key(), l.text(), l.changed(), true, null,
                        l.newLine() == null ? null : w.refs.get(l.newLine())));
            }
        } else if (w.symbol != null) {
            lines = render(w, w.symbol.startLine(), w.symbol.endLine(), own);
        } else {
            int min = w.anchors.values().stream().min(Integer::compare).orElse(1);
            int max = w.anchors.values().stream().max(Integer::compare).orElse(1);
            lines = render(w, Math.max(1, min - 3), max + 3, own);
        }
        if (lines.size() > MAX_DISPLAY_LINES) {
            List<DisplayLine> rest = List.copyOf(lines.subList(MAX_DISPLAY_LINES, lines.size()));
            int hidden = rest.size();
            lines = new ArrayList<>(lines.subList(0, MAX_DISPLAY_LINES));
            lines.add(new DisplayLine("gap", null, null, null, hidden + " weitere Zeilen (zu gross für die Anzeige)", false, false, hidden, null, rest));
        }
        Symbol s = w.symbol;
        return new Segment(w.id, w.file.path(), w.file.language(), w.kind,
                s == null ? null : s.displayName(), s == null ? null : s.kind(),
                s == null ? null : s.startLine(), s == null ? null : s.endLine(),
                w.category, w.group, w.rule == null ? null : w.rule.id(), w.reason, List.copyOf(own), lines,
                List.copyOf(places), List.copyOf(testedBy), w.layer, w.frontend, signature);
    }

    /** Lines of the new file in [start, end] with deletions woven in; long unchanged stretches collapse to gaps. */
    private static List<DisplayLine> render(Work w, int start, int end, Set<String> own) {
        List<FileView.Entry> es = w.ctx.view.entries.stream().filter(e -> e.inRange(start, end)).toList();
        boolean[] keep = new boolean[es.size()];
        for (int i = 0; i < es.size(); i++) {
            FileView.Entry e = es.get(i);
            boolean important = (e.changed() && own.contains(e.key())) || (e.newLine() != null && w.refs.containsKey(e.newLine()));
            if (important) {
                for (int j = Math.max(0, i - CONTEXT); j <= Math.min(es.size() - 1, i + CONTEXT); j++) {
                    keep[j] = true;
                }
            }
        }
        if (es.size() > 0) {
            keep[0] = true;
            keep[es.size() - 1] = true;
        }
        List<DisplayLine> out = new ArrayList<>();
        int i = 0;
        while (i < es.size()) {
            if (keep[i]) {
                FileView.Entry e = es.get(i);
                out.add(new DisplayLine(e.type(), e.oldLine(), e.newLine(), e.key(), e.text(),
                        e.changed() && own.contains(e.key()), e.inDiff(), null,
                        e.newLine() == null ? null : w.refs.get(e.newLine())));
                i++;
                continue;
            }
            int j = i;
            while (j < es.size() && !keep[j]) {
                j++;
            }
            List<DisplayLine> skipped = new ArrayList<>();
            for (int k = i; k < j; k++) {
                FileView.Entry e = es.get(k);
                skipped.add(new DisplayLine(e.type(), e.oldLine(), e.newLine(), e.key(), e.text(),
                        e.changed() && own.contains(e.key()), e.inDiff(), null, null));
            }
            if (j - i < 3) {
                out.addAll(skipped);
            } else {
                // the skipped lines travel along: the UI expands them and highlights across them (comments)
                out.add(new DisplayLine("gap", null, null, null, null, false, false, j - i, null, skipped));
            }
            i = j;
        }
        return out;
    }

    /** The categories of the PR: every module builds its own groups from the facts about the segments. */
    private List<Category> categories(List<Work> works, List<Flow> flows, Set<String> inFlows) {
        List<SegmentFacts> facts = works.stream().map(w -> new SegmentFacts(w.id, w.file.path(), w.category, w.group, w.layer,
                w.aspect == null ? null : w.aspect.category(), w.concerns,
                Structure.ADAPTER.equals(w.layer) ? Structure.adapterDirection(w.file.path()) : null, inFlows.contains(w.id))).toList();
        CategoryContext context = new CategoryContext(facts, flows, rules.rules.stream().map(Rules.Rule::group).distinct().toList());
        List<Category> result = new ArrayList<>();
        for (CategoryModule module : modules) {
            List<Group> groups = module.groups(context);
            if (!groups.isEmpty()) {
                CategoryInfo info = module.info();
                result.add(new Category(info.id(), info.label(), info.summary(), info.icon(), groups,
                        info.builds(), info.divides(), module.view(), module.origin()));
            }
        }
        return result;
    }

    // ------------------------------------------------------------------ components

    /**
     * Groups the changed code into components (files with the same name in the same folder) and assigns each a
     * column of the overview diagram. componentOf receives segment id -> component id.
     */
    private static List<Component> components(List<Work> works, boolean hexagonal, Map<String, String> componentOf) {
        Map<String, List<Work>> byKey = new LinkedHashMap<>();
        for (Work w : works) {
            boolean code = Languages.hasSymbols(w.file.language()) || (w.frontend && "xml".equals(w.file.language()));
            if (code && (w.rule == null || w.rule.extras() || isTest(w))) {
                byKey.computeIfAbsent(Structure.componentKey(w.file.path()), k -> new ArrayList<>()).add(w);
            }
        }
        for (Work w : works) { // styles and templates join the component of the same name
            String key = Structure.componentKey(w.file.path());
            if (byKey.containsKey(key) && !byKey.get(key).contains(w)) {
                byKey.get(key).add(w);
            }
        }
        List<Component> result = new ArrayList<>();
        byKey.forEach((key, members) -> {
            members.forEach(w -> componentOf.put(w.id, key));
            List<String> paths = Structure.unique(members.stream().map(w -> w.file.path()).toList());
            result.add(new Component(key, componentName(key, members), paths, area(members, hexagonal),
                    members.stream().map(w -> w.id).toList()));
        });
        return result;
    }

    /**
     * The class named like the file (PlayerResource.java), else the class most segments belong to, else the file
     * name (local_config). Tests keep their file name so they differ from the component they test.
     */
    private static String componentName(String key, List<Work> members) {
        String stem = key.substring(key.lastIndexOf('/') + 1);
        if (members.stream().allMatch(Analyzer::isTest) || members.stream().anyMatch(w -> w.symbol != null
                && (stem.equals(w.symbol.name()) || stem.equals(w.symbol.container())))) {
            return stem;
        }
        Map<String, Long> containers = members.stream()
                .map(w -> w.symbol == null ? null : w.symbol.kind().equals("class") ? w.symbol.name() : w.symbol.container())
                .filter(c -> c != null && !c.contains(" "))
                .collect(Collectors.groupingBy(c -> c, LinkedHashMap::new, Collectors.counting()));
        return containers.entrySet().stream().max(Map.Entry.comparingByValue()).map(Map.Entry::getKey)
                .orElse(key.substring(key.lastIndexOf('/') + 1));
    }

    private static String area(List<Work> members, boolean hexagonal) {
        if (members.stream().allMatch(Analyzer::isTest)) {
            return "test";
        }
        if (members.stream().anyMatch(w -> w.frontend)) {
            return "frontend";
        }
        String path = members.getFirst().file.path();
        String layer = members.stream().map(w -> w.layer).filter(l -> l != null).findFirst()
                .orElse(hexagonal ? Structure.layerOf(path) : null);
        if (layer != null) {
            return switch (layer) {
                case Structure.ADAPTER -> "out".equals(Structure.adapterDirection(path)) ? "adapter-out" : "adapter-in";
                case Structure.USECASE -> "usecase";
                case Structure.APPLICATION -> "application";
                default -> "domain";
            };
        }
        if (API_LAYER.matcher(path).find()) {
            return "api";
        }
        if (DOMAIN_DIR.matcher("/" + path).find()) {
            return "domain";
        }
        return DEEP_LAYER.matcher(path).find() ? "data" : "logic";
    }

    private static List<ComponentEdge> componentEdges(List<FlowEdge> edges, Map<String, String> componentOf) {
        Map<String, int[]> calls = new LinkedHashMap<>();
        Map<String, Boolean> http = new HashMap<>();
        for (FlowEdge e : edges) {
            String a = componentOf.get(e.from());
            String b = componentOf.get(e.to());
            if (a == null || b == null || a.equals(b)) {
                continue;
            }
            String k = a + "\u0000" + b;
            calls.computeIfAbsent(k, x -> new int[1])[0]++;
            http.merge(k, "http".equals(e.kind()), Boolean::logicalOr);
        }
        List<ComponentEdge> result = new ArrayList<>();
        calls.forEach((k, n) -> {
            String[] ab = k.split("\u0000");
            result.add(new ComponentEdge(ab[0], ab[1], n[0], http.get(k)));
        });
        return result;
    }
}
