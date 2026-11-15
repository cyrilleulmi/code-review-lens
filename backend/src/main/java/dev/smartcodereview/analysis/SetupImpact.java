package dev.smartcodereview.analysis;

import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.model.Model.AffectedTest;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wirkung von Setup und Testdaten: a changed beforeEach, @BeforeEach method, shared fixture or test helper silently
 * changes the meaning of every test that uses it - also of tests the diff does not show. Deterministic, no AI:
 * <ol>
 *   <li><b>Pieces</b> - changed segments of test files (path rule of category tests) and test-support files (rules
 *       "setupImpact.supportPaths"): setup blocks (kind setup), fixtures (top-level constants; fields and suite-level
 *       variables with a value, on changed lines of a class or describe block) and helpers (functions, methods and
 *       classes that are no tests or suites; a constructor stands for its class).</li>
 *   <li><b>Setup blocks</b> affect every test inside the suite or class they are declared in (nested suites and
 *       {@code @Nested} classes included); a top-level block the whole file; a class also its subclasses
 *       ({@code extends C}) in the other test files.</li>
 *   <li><b>Fixtures and helpers</b> affect every test whose code references the name - its own lines, the setup blocks
 *       that run for it and the loose code (headers, fields without value) of its enclosing suites and classes - directly
 *       or through other helpers, fields and constants that reference it (transitively, until nothing new is found).
 *       Methods and short or generic names need call syntax ({@code name(}), constants, fields and classes a whole
 *       word. Other test files see a name only with import evidence: TS/JS import the file (or the name), Java/Kotlin
 *       name the class (same package or import), Go share the directory.</li>
 * </ol>
 * Searched are all test files of the PR (also their unchanged tests) and the existing test files loaded for the change
 * ({@link RelatedTests}).
 */
public final class SetupImpact {

    public static final String SETUP = "setup";
    public static final String FIXTURE = "fixture";
    public static final String HELPER = "helper";
    private static final String UNCHANGED = "unchanged";

    /** Names too generic to link by mere mention (shared with the call graph); they need call syntax. */
    private static final Set<String> GENERIC = Analyzer.GENERIC_NAMES;
    /** Methods that stand for their class when changed. */
    private static final Set<String> CONSTRUCTORS = Set.of("constructor", "init", "__init__");
    /** A JS/TS variable with a value: `const api = {`, `let player = build()`. */
    private static final Pattern JS_VARIABLE = Pattern.compile(
            "^\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=(?![=>])");
    /** A Java/Kotlin/TS class field with a value: `private static final Player CARMELA = …`, `val x = …`. */
    private static final Pattern FIELD = Pattern.compile(
            "^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*(?:(?:private|protected|public|static|final|readonly|val|var|lateinit|internal|override|const)\\s+)*"
                    + "(?:[A-Za-z_$][\\w$.]*(?:<[^=;()]*>)?(?:\\[\\])*\\??\\s+)?([A-Za-z_$][\\w$]*)\\s*(?::\\s*[\\w$.<>?,\\[\\] ]+)?=(?![=>])");
    private static final Pattern TRIVIAL = Pattern.compile("^[\\s{}()\\[\\];,]*$");
    private static final Pattern JVM = Pattern.compile("\\.(java|kt|kts|groovy|scala)$");

    /** Status of a test in its file: Spec-Diff status ("added", "changed", "renamed", "unchanged") and its segment. */
    public record TestState(String status, String segmentId) {
    }

    /** How the status of a test is found (Spec-Diff, segments of the PR). */
    @FunctionalInterface
    public interface StateLookup {
        TestState of(Symbol test);
    }

    /**
     * A file to search: a test file of the PR, a test-support file of the PR or an existing test file loaded for the
     * change (existing = true: all its tests are unchanged). states may be null for existing files.
     */
    public record TestFile(String path, CodeText text, List<Symbol> symbols, boolean existing, StateLookup states) {
    }

    /**
     * A changed segment of a test or test-support file: its symbol (null: module level), its added lines (1-based, new
     * file) and its deleted lines as code with the new-file line they sit before (deleted lines lie between anchor - 1
     * and anchor).
     */
    public record Changed(String segmentId, String path, Symbol symbol, Set<Integer> changedLines, Map<Integer, String> deletedAt) {
        public Changed(String segmentId, String path, Symbol symbol, Set<Integer> changedLines) {
            this(segmentId, path, symbol, changedLines, Map.of());
        }
    }

    /** How a name is used: as a whole word (constants, fields, classes) or only as a call (methods, generic names). */
    private record Name(String name, boolean call, String path, String container, Symbol within, boolean crossFile,
                        Pattern pattern) {
        static Name of(String name, boolean call, String path, String container, Symbol within, boolean crossFile) {
            String q = Pattern.quote(name);
            Pattern p = call
                    ? Pattern.compile("(?<![\\w$])" + q + "\\s*(?:<[^<>()]*>)?\\s*\\(|::" + q + "(?![\\w$])")
                    : Pattern.compile("(?<![\\w$])" + q + "(?![\\w$])(?!:(?!:))");
            return new Name(name, call, path, container, within, crossFile, p);
        }

        String key() {
            return path + "\u0000" + name + "\u0000" + (within == null ? "" : within.startLine());
        }
    }

    /** A changed piece of setup: kind, display name, declaration lines and where it is visible in its own file. */
    private record Piece(String segmentId, String path, String kind, String name, int line, int start, int end,
                         Symbol scope, Name ref) {
    }

    /** A named unit a reference can pass through: helper, constant, field (range = its declaration). */
    private record Unit(Name name, int start, int end) {
    }

    /** Pre-computed structure of one file. */
    private static final class FileModel {
        final TestFile file;
        final List<Symbol> tests = new ArrayList<>();
        /** suites and classes */
        final List<Symbol> scopes = new ArrayList<>();
        final List<Symbol> setups = new ArrayList<>();
        final List<Unit> units = new ArrayList<>();
        /** declaration ranges of fields / suite variables with a value (0-based start/end lines), excluded from scope code */
        final List<int[]> fieldRanges = new ArrayList<>();
        final Map<Symbol, String> scopeCode = new HashMap<>();
        final String stem;
        final String importsText;
        final String language;
        /** the whole code (strings and comments blanked) in one string, for the import evidence */
        final String allCode;
        /** visibleIn results by name: asked once per file and name, not once per round */
        final Map<String, Boolean> visible = new HashMap<>();

        FileModel(TestFile file) {
            this.file = file;
            for (Symbol s : file.symbols()) {
                switch (s.kind()) {
                    case "test" -> tests.add(s);
                    case "suite" -> scopes.add(s);
                    case "setup" -> setups.add(s);
                    case "class" -> scopes.add(s);
                    default -> {
                    }
                }
            }
            this.stem = stemOf(file.path());
            this.language = languageOf(file.path());
            this.allCode = String.join("\n", file.text().code);
            StringBuilder imports = new StringBuilder();
            for (int i = 0; i < file.text().visible.size(); i++) {
                String c = file.text().code.get(i).strip();
                if (c.startsWith("import ") || c.startsWith("import{") || c.contains("require(") || c.startsWith("} from")
                        || c.startsWith("from ")) {
                    imports.append(file.text().visible.get(i)).append('\n');
                }
            }
            // multi-line TS imports: `import {` … `} from './x'` - the names in between are mentioned in the code anyway
            this.importsText = imports.toString();
            for (Symbol s : file.symbols()) {
                if (s.isTestBlock() || "type".equals(s.kind()) || "interface".equals(s.kind()) || "enum".equals(s.kind())) {
                    continue;
                }
                if ("class".equals(s.kind()) && hasTests(s)) {
                    continue;
                }
                units.add(new Unit(nameOf(s, file.path(), innermostScope(s)), s.startLine(), s.endLine()));
            }
            for (Symbol scope : scopes) {
                for (int[] d : declarations(scope)) {
                    fieldRanges.add(d);
                    String n = declaredName(d[0]);
                    if (n != null) {
                        units.add(new Unit(Name.of(n, false, file.path(), "class".equals(scope.kind()) ? scope.name() : null,
                                scope, crossFileField(d[0], scope)), d[0] + 1, d[1] + 1));
                    }
                }
            }
        }

        boolean hasTests(Symbol scope) {
            return tests.stream().anyMatch(t -> encloses(scope, t));
        }

        /** The innermost suite or class strictly enclosing s, or null (top level). */
        Symbol innermostScope(Symbol s) {
            Symbol best = null;
            for (Symbol c : scopes) {
                if (c != s && encloses(c, s) && c.span() >= s.span() && !(c.startLine() == s.startLine() && c.endLine() == s.endLine())
                        && (best == null || c.span() < best.span())) {
                    best = c;
                }
            }
            return best;
        }

        /**
         * Field and variable declarations with a value directly in a suite or class (not inside a member), as 0-based
         * [start, end] lines.
         */
        List<int[]> declarations(Symbol scope) {
            List<int[]> result = new ArrayList<>();
            List<Symbol> members = file.symbols().stream().filter(c -> c != scope && encloses(scope, c)
                    && c.span() < scope.span()).toList();
            CodeText text = file.text();
            for (int li = scope.startLine(); li < scope.endLine() - 1 && li < text.code.size(); li++) {
                int line = li + 1; // 1-based
                if (line == scope.startLine() || members.stream().anyMatch(m -> m.contains(line))) {
                    continue;
                }
                if (declaredName(li) != null) {
                    int end = Math.min(text.statementEnd(li), scope.endLine() - 1);
                    result.add(new int[]{li, end});
                    li = end;
                }
            }
            return result;
        }

        /** The name declared with a value at line li (0-based), or null. */
        String declaredName(int li) {
            String code = file.text().code.get(li);
            Matcher m = JS_VARIABLE.matcher(code);
            if (m.find()) {
                return m.group(1);
            }
            m = FIELD.matcher(code);
            return m.find() && !GENERIC_KEYWORDS.contains(m.group(1)) ? m.group(1) : null;
        }

        /** A JVM field is visible from other files when it is static and not private (`TestData.CARMELA`). */
        boolean crossFileField(int li, Symbol scope) {
            String code = file.text().code.get(li);
            return "class".equals(scope.kind()) && JVM.matcher(file.path()).find() && code.matches(".*\\bstatic\\b.*")
                    && !code.matches(".*\\bprivate\\b.*");
        }

        /** The code a test runs: its own lines, the setup blocks of its scopes and the loose code of its suites/classes. */
        String scopeCode(Symbol test) {
            return scopeCode.computeIfAbsent(test, t -> {
                CodeText text = file.text();
                boolean[] take = new boolean[text.code.size()];
                mark(take, t.startLine(), t.endLine());
                List<Symbol> enclosing = scopes.stream().filter(s -> encloses(s, t) && s != t).toList();
                for (Symbol setup : setups) {
                    Symbol scope = innermostScope(setup);
                    if (scope == null || encloses(scope, t)) {
                        mark(take, setup.startLine(), setup.endLine());
                    }
                }
                for (Symbol e : enclosing) {
                    List<Symbol> members = file.symbols().stream().filter(c -> c != e && encloses(e, c) && c.span() < e.span()).toList();
                    for (int line = e.startLine(); line <= e.endLine(); line++) {
                        int ln = line;
                        if (members.stream().noneMatch(m -> m.contains(ln)) && fieldRanges.stream().noneMatch(r -> r[0] + 1 <= ln && ln <= r[1] + 1)) {
                            mark(take, ln, ln);
                        }
                    }
                }
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < take.length; i++) {
                    if (take[i]) {
                        sb.append(text.code.get(i));
                    }
                    sb.append('\n');
                }
                return sb.toString();
            });
        }

        String code(int start, int end) {
            CodeText text = file.text();
            StringBuilder sb = new StringBuilder();
            for (int i = Math.max(1, start); i <= end && i <= text.code.size(); i++) {
                sb.append(text.code.get(i - 1)).append('\n');
            }
            return sb.toString();
        }

        private static void mark(boolean[] take, int from, int to) {
            for (int i = Math.max(1, from); i <= to && i <= take.length; i++) {
                take[i - 1] = true;
            }
        }
    }

    /** Field names that are keywords of a statement, not declarations (`return x = …` never occurs at class level). */
    private static final Set<String> GENERIC_KEYWORDS = Set.of("return", "this", "super", "new", "if", "else", "for", "while");

    private SetupImpact() {
    }

    /** Is this file searched for setup pieces (path rule of the tests category, or a test-support path)? */
    public static boolean isTestOrSupport(Rules rules, String path) {
        Rules.Rule r = rules.forPath(path);
        return (r != null && "tests".equals(r.category())) || rules.setupImpact.isSupport(path);
    }

    /**
     * The impacts of the changed segments on the tests of the given files, by path and line of the piece. changed: the
     * changed segments of test and test-support files; files: all files to search (those of the changed segments
     * included).
     */
    public static List<dev.smartcodereview.model.Model.SetupImpact> find(List<Changed> changed, List<TestFile> files) {
        Map<String, FileModel> models = new LinkedHashMap<>();
        for (TestFile f : files) {
            models.put(f.path(), new FileModel(f));
        }
        List<Piece> pieces = new ArrayList<>();
        for (Changed c : changed) {
            FileModel m = models.get(c.path());
            if (m != null && c.symbol() != null && nonTrivial(m.file.text(), c)) {
                pieces.addAll(piecesOf(c, m));
            }
        }
        pieces.sort(Comparator.comparing(Piece::path).thenComparingInt(Piece::line).thenComparing(Piece::name));
        List<dev.smartcodereview.model.Model.SetupImpact> result = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Piece p : pieces) {
            if (!seen.add(p.segmentId() + "\u0000" + p.name() + "\u0000" + p.line())) {
                continue;
            }
            List<AffectedTest> affected = affected(p, models);
            if (affected.isEmpty()) {
                continue;
            }
            int unchanged = (int) affected.stream().filter(a -> UNCHANGED.equals(a.status())).count();
            result.add(new dev.smartcodereview.model.Model.SetupImpact(p.segmentId(), p.kind(), p.name(), p.line(),
                    List.copyOf(affected), unchanged));
        }
        return result;
    }

    // ------------------------------------------------------------------ pieces

    private static List<Piece> piecesOf(Changed c, FileModel m) {
        Symbol s = c.symbol();
        String path = c.path();
        List<Piece> result = new ArrayList<>();
        switch (s.kind()) {
            case "setup" -> result.add(new Piece(c.segmentId(), path, SETUP, s.displayName(), s.startLine(), s.startLine(),
                    s.endLine(), m.innermostScope(s), null));
            case "const" -> result.add(new Piece(c.segmentId(), path, FIXTURE, s.name(), s.startLine(), s.startLine(), s.endLine(),
                    null, nameOf(s, path, m.innermostScope(s))));
            case "function", "method", "component" -> {
                Name ref = nameOf(s, path, m.innermostScope(s));
                String display = CONSTRUCTORS.contains(s.name()) || s.name().equals(s.container()) ? s.container()
                        : s.displayName();
                if (ref != null) {
                    result.add(new Piece(c.segmentId(), path, HELPER, display, s.startLine(), s.startLine(), s.endLine(), null, ref));
                }
            }
            case "class", "suite" -> {
                boolean anyField = false;
                for (int[] d : m.declarations(s)) {
                    boolean hit = c.changedLines().stream().anyMatch(l -> l >= d[0] + 1 && l <= d[1] + 1
                            && !TRIVIAL.matcher(m.file.text().code.get(l - 1)).matches())
                            || c.deletedAt().entrySet().stream().anyMatch(e -> e.getKey() > d[0] + 1 && e.getKey() <= d[1] + 1
                            && !trivialText(e.getValue()));
                    String n = m.declaredName(d[0]);
                    if (hit && n != null) {
                        anyField = true;
                        Name ref = Name.of(n, false, path, "class".equals(s.kind()) ? s.name() : null, s, m.crossFileField(d[0], s));
                        result.add(new Piece(c.segmentId(), path, FIXTURE, n, d[0] + 1, d[0] + 1, d[1] + 1, s, ref));
                    }
                }
                if (!anyField && "class".equals(s.kind()) && !m.hasTests(s)) {
                    result.add(new Piece(c.segmentId(), path, HELPER, s.name(), s.startLine(), s.startLine(), s.endLine(), null,
                            nameOf(s, path, m.innermostScope(s))));
                }
            }
            default -> {
                // tests, types, interfaces, enums: no setup
            }
        }
        return result;
    }

    /** How a unit is referenced: a constructor by its class, methods by call, specific function names as a word. */
    private static Name nameOf(Symbol s, String path, Symbol within) {
        String name = s.name();
        String container = s.container();
        boolean call;
        if ((CONSTRUCTORS.contains(name) || name.equals(container)) && container != null) {
            name = container;
            call = false;
            container = null;
        } else if ("method".equals(s.kind())) {
            call = true;
        } else if ("function".equals(s.kind()) || "component".equals(s.kind())) {
            call = GENERIC.contains(name) || name.length() < 5;
        } else {
            call = false;
        }
        boolean crossFile = within == null || "class".equals(within.kind());
        return Name.of(name, call, path, container, within, crossFile);
    }

    /** Some added line has code (not only braces, blanks, comments), or some deleted line had. */
    private static boolean nonTrivial(CodeText text, Changed c) {
        for (int l : c.changedLines()) {
            if (l >= 1 && l <= text.code.size() && !TRIVIAL.matcher(text.code.get(l - 1)).matches()) {
                return true;
            }
        }
        return c.deletedAt().values().stream().anyMatch(t -> !trivialText(t));
    }

    /** A raw line (deleted, so without a code-only copy) that is blank, braces only or a comment. */
    private static boolean trivialText(String raw) {
        String t = raw.strip();
        return TRIVIAL.matcher(t).matches() || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
    }

    // ------------------------------------------------------------------ affected tests

    private static List<AffectedTest> affected(Piece p, Map<String, FileModel> models) {
        Map<String, Set<Symbol>> hits = new LinkedHashMap<>();
        if (SETUP.equals(p.kind())) {
            FileModel own = models.get(p.path());
            for (Symbol t : own.tests) {
                if (p.scope() == null || encloses(p.scope(), t)) {
                    hits.computeIfAbsent(own.file.path(), k -> new LinkedHashSet<>()).add(t);
                }
            }
            if (p.scope() != null && "class".equals(p.scope().kind())) {
                subclassTests(p.scope().name(), own, models, hits);
            }
        } else {
            Map<String, Map<String, Name>> visible = closure(p, models);
            for (FileModel m : models.values()) {
                List<Name> names = List.copyOf(visible.getOrDefault(m.file.path(), Map.of()).values());
                if (names.isEmpty()) {
                    continue;
                }
                for (Symbol t : m.tests) {
                    String code = m.scopeCode(t);
                    if (names.stream().anyMatch(n -> sees(m, n, t) && n.pattern().matcher(code).find())) {
                        hits.computeIfAbsent(m.file.path(), k -> new LinkedHashSet<>()).add(t);
                    }
                }
            }
        }
        List<AffectedTest> result = new ArrayList<>();
        for (Map.Entry<String, Set<Symbol>> e : hits.entrySet()) {
            FileModel m = models.get(e.getKey());
            for (Symbol t : e.getValue()) {
                TestState state = m.file.existing() || m.file.states() == null ? null : m.file.states().of(t);
                String status = m.file.existing() ? UNCHANGED : state == null || state.status() == null ? UNCHANGED : state.status();
                String segmentId = state == null ? null : state.segmentId();
                result.add(new AffectedTest(m.file.path(), t.displayName(), t.startLine(), segmentId, status, m.file.existing()));
            }
        }
        // the piece's own file first, then by path and line
        result.sort(Comparator.comparing((AffectedTest a) -> !a.path().equals(p.path())).thenComparing(AffectedTest::path)
                .thenComparingInt(AffectedTest::line));
        return result;
    }

    /** Tests in classes that extend the class (any searched file): its setup methods run for them too. */
    private static void subclassTests(String className, FileModel own, Map<String, FileModel> models, Map<String, Set<Symbol>> hits) {
        Pattern extendsIt = Pattern.compile("\\bextends\\s+" + Pattern.quote(className) + "\\b|\\bclass\\s+\\w+[^{]*:\\s*"
                + Pattern.quote(className) + "\\s*\\(");
        for (FileModel m : models.values()) {
            if (!m.language.equals(own.language)) {
                continue;
            }
            for (Symbol c : m.scopes) {
                if (!"class".equals(c.kind()) || c.name().equals(className)) {
                    continue;
                }
                String head = m.code(c.startLine(), Math.min(c.endLine(), c.startLine() + 4));
                int brace = head.indexOf('{');
                if (extendsIt.matcher(brace < 0 ? head : head.substring(0, brace)).find()) {
                    for (Symbol t : m.tests) {
                        if (encloses(c, t)) {
                            hits.computeIfAbsent(m.file.path(), k -> new LinkedHashSet<>()).add(t);
                        }
                    }
                }
            }
        }
    }

    /**
     * The names through which the piece reaches tests, by file: the piece itself where it is visible, then every unit
     * (helper, constant, field) that references a visible name, until nothing new is found.
     */
    private static Map<String, Map<String, Name>> closure(Piece p, Map<String, FileModel> models) {
        List<Name> all = new ArrayList<>();
        all.add(p.ref());
        Map<String, Map<String, Name>> visible = new LinkedHashMap<>();
        Set<String> added = new LinkedHashSet<>();
        added.add(p.ref().key());
        boolean grew = true;
        for (int round = 0; grew && round < 20; round++) {
            grew = false;
            for (FileModel m : models.values()) {
                Map<String, Name> names = visible.computeIfAbsent(m.file.path(), k -> new LinkedHashMap<>());
                for (Name n : all) {
                    if (!names.containsKey(n.key()) && visibleIn(m, n)) {
                        names.put(n.key(), n);
                    }
                }
                for (Unit u : m.units) {
                    if (added.contains(u.name().key()) || (m.file.path().equals(p.path()) && overlaps(u, p))) {
                        continue;
                    }
                    String code = m.code(u.start(), u.end());
                    for (Name n : names.values()) {
                        if ((!n.path().equals(m.file.path()) || n.within() == null || within(n.within(), u.start()))
                                && !(n.path().equals(m.file.path()) && n.name().equals(u.name().name()))
                                && n.pattern().matcher(code).find()) {
                            added.add(u.name().key());
                            all.add(u.name());
                            grew = true;
                            break;
                        }
                    }
                }
            }
        }
        return visible;
    }

    /** A unit that contains the piece, or the piece itself, is no way to reach it. */
    private static boolean overlaps(Unit u, Piece p) {
        return u.start() <= p.start() && u.end() >= p.end();
    }

    /** Does a test of file m see the name (own file: inside the scope it is declared in)? */
    private static boolean sees(FileModel m, Name n, Symbol test) {
        return !n.path().equals(m.file.path()) || n.within() == null || encloses(n.within(), test);
    }

    private static boolean within(Symbol scope, int line) {
        return scope.contains(line);
    }

    /**
     * Is a name declared in another file visible in m? Same file always; else only names that can be imported, with
     * evidence: Java/Kotlin name the class (or the top-level function), TS/JS import the file or the name, Go share the
     * directory.
     */
    private static boolean visibleIn(FileModel m, Name n) {
        if (n.path().equals(m.file.path())) {
            return true;
        }
        return m.visible.computeIfAbsent(n.key() + "\u0000" + n.container() + "\u0000" + n.crossFile(), k -> evidence(m, n));
    }

    private static boolean evidence(FileModel m, Name n) {
        if (!n.crossFile() || !m.language.equals(languageOf(n.path()))) {
            return false;
        }
        String code = m.allCode;
        switch (m.language) {
            case "jvm" -> {
                String owner = n.container() != null ? n.container() : n.name();
                return Pattern.compile("(?<![\\w$])" + Pattern.quote(owner) + "(?![\\w$])").matcher(code).find()
                        || Pattern.compile("(?<![\\w$])" + Pattern.quote(n.name()) + "(?![\\w$])").matcher(m.importsText).find();
            }
            case "go" -> {
                return dirOf(n.path()).equals(dirOf(m.file.path()));
            }
            default -> {
                String stem = stemOf(n.path());
                boolean importsFile = Pattern.compile("[/'\"]" + Pattern.quote(stem) + "['\"./]").matcher(m.importsText).find();
                String owner = n.container() != null ? n.container() : n.name();
                boolean importsName = Pattern.compile("(?<![\\w$])" + Pattern.quote(owner) + "(?![\\w$])").matcher(code).find();
                return importsFile && importsName;
            }
        }
    }

    private static boolean encloses(Symbol outer, Symbol inner) {
        return outer.startLine() <= inner.startLine() && outer.endLine() >= inner.endLine();
    }

    private static String languageOf(String path) {
        if (JVM.matcher(path).find()) {
            return "jvm";
        }
        if (path.endsWith(".go")) {
            return "go";
        }
        if (path.matches(".*\\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$")) {
            return "js";
        }
        return path.substring(path.lastIndexOf('.') + 1);
    }

    /** File name without extensions (`player.fixture.ts` -> `player.fixture`); `index` files: their directory. */
    private static String stemOf(String path) {
        String file = path.substring(path.lastIndexOf('/') + 1);
        String stem = file.contains(".") ? file.substring(0, file.lastIndexOf('.')) : file;
        if (stem.equals("index")) {
            String dir = dirOf(path);
            stem = dir.substring(dir.lastIndexOf('/') + 1);
        }
        return stem;
    }

    private static String dirOf(String path) {
        return path.contains("/") ? path.substring(0, path.lastIndexOf('/')) : "";
    }
}
