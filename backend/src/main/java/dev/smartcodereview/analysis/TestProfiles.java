package dev.smartcodereview.analysis;

import dev.smartcodereview.analysis.Expectations.Assertion;
import dev.smartcodereview.analysis.SymbolExtractor.EachTable;
import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.model.Model.TestProfile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Test-Steckbrief: one line per test case - what it calls, which case it covers (error, edge, normal), what it
 * asserts, what it mocks, on which level it runs and how many parameterised cases it has. Deterministic and
 * pattern-based (rules section "testProfile", see {@link Rules.TestProfileRules}), no AI.
 * <p>
 * The parts of a test ({@link #read}) are reusable on their own (e.g. to compare similar tests):
 * <ul>
 *   <li><b>head</b>: annotation and comment lines above the declaration; <b>body</b>: the test from just after the
 *       first "{" or "=>" of its declaration (after the table of an it.each) to its end. Both as "visible" text:
 *       comments blanked, string contents kept.</li>
 *   <li><b>surroundings</b>: the whole file without other test cases and without suites/classes that do not enclose
 *       the test - i.e. imports, top-level code, the fields, annotations and setup blocks of the enclosing classes
 *       and describe blocks, and the test itself.</li>
 *   <li><b>assertions</b>: the assertion statements of the body ({@link Expectations#assertions}).</li>
 * </ul>
 * Parameterised cases are syntax, not heuristics, and therefore not in the rules: JUnit @ParameterizedTest with
 * @ValueSource (elements), @CsvSource (rows, also text blocks), @EnumSource(names = …), @NullSource / @EmptySource
 * (1 each), @NullAndEmptySource (2); other sources (@MethodSource, @CsvFileSource, …) make the count unknown.
 * JS/TS it.each / test.each with a literal array (elements) or a template table (rows minus the header). Go table
 * tests: a `for _, tt := range tests` loop over a slice/map literal declared in the test body (its entries).
 * {@link #table} reads the same sources with the values of each row (for the Fallmatrix, {@link CaseMatrices}).
 */
public final class TestProfiles {

    public static final String ERROR = "error";
    public static final String EDGE = "edge";
    public static final String NORMAL = "normal";
    public static final String UNIT = "unit";
    public static final String BY_CODE = "code";
    public static final String BY_NAME = "name";
    public static final String BY_PATH = "path";
    public static final String EXISTENCE = "existence";
    public static final String OTHER = "other";
    /** The fixed name of a mocked HTTP backend (HttpTestingController, MockWebServer, ...). */
    public static final String HTTP = "HTTP";

    /** Longest reason text (matched code) kept. */
    private static final int MAX_REASON = 80;
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z_$][\\w$]*");
    private static final Pattern NAME_START = Pattern.compile("^\\s*@([\\w.]+)");
    private static final Pattern GO_RANGE = Pattern.compile("\\bfor\\s+\\w+\\s*(?:,\\s*\\w+\\s*)?:=\\s*range\\s+(\\w+)\\s*\\{");
    private static final Pattern MOCK_PREFIX = Pattern.compile("^(?i:mock|fake|stub|spy)(?=[A-Z])");
    private static final Pattern MOCK_SUFFIX = Pattern.compile("(?<=[a-z0-9])(?:Mocks?|Spy|SpyObj|Stub|Fake|Double)$");
    /** Variables that hold the test fixture, not a collaborator (spyOn(component, …) mocks a part of the unit). */
    private static final Set<String> NO_COLLABORATOR = Set.of("this", "component", "fixture", "sut", "underTest", "subject");

    private final Rules.TestProfileRules rules;
    private final Expectations expectations;

    public TestProfiles(Rules rules) {
        this.rules = rules.testProfile;
        this.expectations = new Expectations(rules);
    }

    /**
     * The parts of a test case the profile looks at (see the class comment). nameWords: the test name and the names
     * of its enclosing describe blocks as lower-case words; bodyLine: first line of the body (1-based); inputs: the
     * argument lists of the calls to the targets and of the "inputCalls" (HTTP requests) in the body, one per line -
     * what the test feeds the code under test. bodyCode: the body with string contents blanked too (aligned with
     * body: same length, same columns).
     */
    public record TestText(String nameWords, String head, String body, int bodyLine, String bodyWithoutAssertions,
                           String surroundings, List<Assertion> assertions, String inputs, String bodyCode) {
    }

    /**
     * Parameterised cases: parameterized = runs once per row; cases = number of rows or null; source: where from;
     * rows: the text of the sources (source annotations, it.each table, Go table literal), "" when not parameterised.
     */
    public record Cases(boolean parameterized, Integer cases, String source, String rows) {
        static final Cases NONE = new Cases(false, null, null, "");
    }

    /** A classification and why: value (e.g. "error"), by ("code", "name", "path"), the matched text. */
    private record Hit(String value, String by, String text) {
    }

    /**
     * The profile of one test case. targets: what it calls (computed from the call graph by the caller); unit: the
     * unit under test from the test file name (left out of the mocks), may be null.
     */
    public TestProfile profile(String path, CodeText text, List<Symbol> symbols, Symbol test, List<String> targets, String unit) {
        TestText t = read(text, symbols, test, targets);
        Cases cases = cases(text, test);
        Hit scenario = scenario(t, cases);
        Map<String, Integer> kinds = assertionKinds(t.assertions());
        Hit level = level(path, t.surroundings());
        if (scenario == null) {
            scenario = new Hit(NORMAL, null, null);
        }
        if (level == null) {
            level = new Hit(UNIT, null, null);
        }
        return new TestProfile(List.copyOf(targets), scenario.value(), scenario.by(), scenario.text(),
                t.assertions().size(), kinds, mocks(t.surroundings(), unit), level.value(), level.by(), level.text(),
                cases.parameterized(), cases.cases(), cases.source());
    }

    // ------------------------------------------------------------------ the parts of a test

    /**
     * Reads the parts of a test case (see {@link TestText}); targets: names of the code under test (the arguments of
     * calls to them are inputs).
     */
    public TestText read(CodeText text, List<Symbol> symbols, Symbol test, List<String> targets) {
        int last = Math.min(test.endLine(), text.lines.size());
        int decl = Expectations.declarationLine(text, test);
        StringBuilder head = new StringBuilder();
        for (int li = test.startLine(); li < decl; li++) {
            head.append(visible(text, li - 1)).append('\n');
        }
        // the body starts after the first "{" or "=>" of the declaration (after the table of an it.each)
        int fromLine = decl - 1;
        int fromCol = 0;
        EachTable each = SymbolExtractor.eachTable(text, decl - 1);
        if (each != null) {
            fromLine = each.endLine();
            fromCol = each.endCol();
        }
        int[] start = bodyStart(text, fromLine, fromCol, last - 1);
        List<Assertion> assertions = expectations.assertions(text, test);
        boolean[] inAssertion = new boolean[last + 2];
        for (Assertion a : assertions) {
            for (int li = a.line(); li <= Math.min(a.endLine(), last); li++) {
                inAssertion[li] = true;
            }
        }
        StringBuilder body = new StringBuilder();
        StringBuilder bodyCode = new StringBuilder();
        StringBuilder rest = new StringBuilder();
        for (int li = start[0] + 1; li <= last; li++) {
            String v = visible(text, li - 1);
            String c = text.code.get(li - 1);
            if (li == start[0] + 1) {
                v = " ".repeat(Math.min(start[1], v.length())) + v.substring(Math.min(start[1], v.length()));
                c = " ".repeat(Math.min(start[1], c.length())) + c.substring(Math.min(start[1], c.length()));
            }
            body.append(v).append('\n');
            bodyCode.append(c).append('\n');
            rest.append(inAssertion[li] ? "" : v).append('\n');
        }
        return new TestText(nameWords(symbols, test), head.toString(), body.toString(), start[0] + 1, rest.toString(),
                surroundings(text, symbols, test), assertions, inputs(body.toString(), bodyCode.toString(), targets),
                bodyCode.toString());
    }

    /**
     * The argument lists "(…)" of the calls to the targets (`resource.update(id, null)`, also inside an assertion:
     * `expect(valid(null))`) and of the "inputCalls" (HTTP requests) in the body, in order, one per line. body
     * (visible text) and code (strings blanked, for the brackets) are aligned.
     */
    private String inputs(String body, String code, List<String> targets) {
        List<Pattern> calls = new ArrayList<>(rules.inputCalls());
        for (String t : targets) {
            if (IDENTIFIER.matcher(t).matches()) {
                calls.add(Pattern.compile("(?<![\\w$])" + Pattern.quote(t) + "\\s*(?:<[^<>()]*>)?\\s*\\("));
            }
        }
        int httpCalls = rules.inputCalls().size();
        TreeMap<Integer, String> found = new TreeMap<>();
        for (int i = 0; i < calls.size(); i++) {
            Matcher m = calls.get(i).matcher(code);
            while (m.find()) {
                int open = m.end() - 1;
                if (open < 0 || code.charAt(open) != '(') {
                    continue;
                }
                int close = matching(code, open);
                if (close > open) {
                    found.putIfAbsent(open, i < httpCalls ? body.substring(open, close + 1) : topLevel(body, code, open, close));
                }
            }
        }
        return String.join("\n", found.values());
    }

    /**
     * The argument list of a target call with nested multi-argument calls collapsed: `update(id, new Request(null, 7))`
     * -> `(id, new Request(…))`. A null among several fields of an argument is usually an unrelated field (partial
     * update DTO), not the input under test. A nested call with one argument wraps the value itself and stays
     * (`save(new Player(""))`), as do empty ones (`List.of()`, `new ArrayList<>()`).
     */
    private static String topLevel(String body, String code, int open, int close) {
        StringBuilder sb = new StringBuilder("(");
        for (int i = open + 1; i < close; i++) {
            if (code.charAt(i) == '(') {
                int end = matching(code, i);
                if (end > i) {
                    sb.append(hasTopLevelComma(code, i, end) ? "(…)" : topLevel(body, code, i, end));
                    i = end;
                    continue;
                }
            }
            sb.append(body.charAt(i));
        }
        return sb.append(')').toString();
    }

    private static boolean hasTopLevelComma(String code, int open, int close) {
        int depth = 0;
        for (int i = open + 1; i < close; i++) {
            char c = code.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
            } else if (c == ',' && depth == 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * (line, col), 0-based, right after the first "{" or "=>" from (line, col) on; the start when there is none. A "{"
     * right after "(" or "," opens a destructured parameter or an object argument, not the body.
     */
    private static int[] bodyStart(CodeText text, int line, int col, int lastLine) {
        for (int li = line; li <= lastLine && li < text.code.size(); li++) {
            String c = text.code.get(li);
            int from = li == line ? Math.min(col, c.length()) : 0;
            int brace = c.indexOf('{', from);
            while (brace >= 0 && c.substring(from, brace).stripTrailing().matches("(?s).*[(,]")) {
                brace = c.indexOf('{', brace + 1);
            }
            int arrow = c.indexOf("=>", from);
            if (brace >= 0 || arrow >= 0) {
                int end = brace < 0 ? arrow + 2 : arrow < 0 ? brace + 1 : Math.min(brace + 1, arrow + 2);
                return new int[]{li, end};
            }
        }
        return new int[]{line, col};
    }

    /** Test name and enclosing describe blocks, outermost first, as lower-case words. */
    private static String nameWords(List<Symbol> symbols, Symbol test) {
        StringBuilder sb = new StringBuilder();
        symbols.stream()
                .filter(s -> s != test && s.kind().equals("suite") && encloses(s, test))
                .sorted((a, b) -> Integer.compare(a.startLine(), b.startLine()))
                .forEach(s -> sb.append(words(s.name())).append(" | "));
        return sb.append(words(test.name())).toString();
    }

    /**
     * A name as lower-case words: camelCase, snake_case, digits and punctuation split ("rejectsInvalidNumber" ->
     * "rejects invalid number", "TestCreate_Empty" -> "test create empty", "returns404" -> "returns 404").
     */
    static String words(String name) {
        String s = name.replaceAll("([\\p{Ll}\\d])(\\p{Lu})", "$1 $2")
                .replaceAll("(\\p{Lu}+)(\\p{Lu}\\p{Ll})", "$1 $2")
                .replaceAll("(\\p{L})(\\d)", "$1 $2")
                .replaceAll("(\\d)(\\p{L})", "$1 $2")
                .replaceAll("[^\\p{L}\\d]+", " ");
        return s.strip().toLowerCase(Locale.ROOT);
    }

    /** The file without other test cases and without suites/classes that do not enclose the test. */
    private static String surroundings(CodeText text, List<Symbol> symbols, Symbol test) {
        List<Symbol> foreign = new ArrayList<>();
        for (Symbol s : symbols) {
            if (s == test) {
                continue;
            }
            boolean otherTest = s.kind().equals("test");
            boolean otherScope = (s.kind().equals("suite") || s.kind().equals("class")) && !encloses(s, test);
            if (otherTest || otherScope) {
                foreign.add(s);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (int li = 1; li <= text.lines.size(); li++) {
            int line = li;
            if (foreign.stream().noneMatch(s -> s.contains(line))) {
                sb.append(visible(text, li - 1));
            }
            sb.append('\n');
        }
        return sb.toString();
    }

    private static boolean encloses(Symbol outer, Symbol inner) {
        return outer.startLine() <= inner.startLine() && outer.endLine() >= inner.endLine();
    }

    /** A line (0-based) with comments blanked but string contents kept (code and raw text are aligned). */
    static String visible(CodeText text, int li) {
        return text.visible.get(li);
    }

    // ------------------------------------------------------------------ scenario

    /**
     * First hit of errorCode, errorName (-> error), edgeName, edgeCode (-> edge); null = normal. edgeCode only looks at
     * the inputs of the code under test: the parameter sources and the argument lists of target and HTTP calls.
     */
    private Hit scenario(TestText t, Cases cases) {
        String code = t.head() + "\n" + t.body();
        String text;
        if ((text = find(rules.errorCode(), code)) != null) {
            return new Hit(ERROR, BY_CODE, text);
        }
        if ((text = find(rules.errorName(), t.nameWords())) != null) {
            return new Hit(ERROR, BY_NAME, text);
        }
        if ((text = find(rules.edgeName(), t.nameWords())) != null) {
            return new Hit(EDGE, BY_NAME, text);
        }
        if ((text = find(rules.edgeCode(), cases.rows() + "\n" + t.inputs())) != null) {
            return new Hit(EDGE, BY_CODE, text);
        }
        return null;
    }

    /** The text the first matching pattern found (whitespace collapsed, shortened), or null. */
    private static String find(List<Pattern> patterns, String text) {
        for (Pattern p : patterns) {
            Matcher m = p.matcher(text);
            if (m.find()) {
                return reason(m.group());
            }
        }
        return null;
    }

    private static String reason(String matched) {
        String r = matched.replaceAll("\\s+", " ").strip();
        return r.length() > MAX_REASON ? r.substring(0, MAX_REASON - 1) + "…" : r;
    }

    // ------------------------------------------------------------------ assertions

    /** Count per kind (rules order, then "other"); only kinds that occur. */
    Map<String, Integer> assertionKinds(List<Assertion> assertions) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        rules.assertionKinds().keySet().forEach(k -> counts.put(k, 0));
        counts.put(OTHER, 0);
        for (Assertion a : assertions) {
            counts.merge(kindOf(a), 1, Integer::sum);
        }
        counts.values().removeIf(n -> n == 0);
        return counts;
    }

    /** The kind of one assertion statement: the first kind with a matching pattern ("existence": also weak ones). */
    public String kindOf(Assertion a) {
        for (Map.Entry<String, List<Pattern>> k : rules.assertionKinds().entrySet()) {
            if ((k.getKey().equals(EXISTENCE) && a.weak()) || k.getValue().stream().anyMatch(p -> p.matcher(a.code()).find())) {
                return k.getKey();
            }
        }
        return OTHER;
    }

    // ------------------------------------------------------------------ mocks

    /**
     * The collaborators a test case replaces (as in its profile) - needed before the profile, to stop the walk through
     * the call graph at them (Mock-Grenzen, see {@link MockBoundaries}). unit: the unit under test, may be null.
     */
    List<String> mocks(CodeText text, List<Symbol> symbols, Symbol test, String unit) {
        return mocks(surroundings(text, symbols, test), unit);
    }

    /** The test's surroundings (see the class comment): line-aligned with the file, other tests and suites blanked. */
    static String surroundingsOf(CodeText text, List<Symbol> symbols, Symbol test) {
        return surroundings(text, symbols, test);
    }

    /**
     * Where a test stubs or references the member `member` of a mock (rules "mockMembers", first template with a match):
     * the 1-based line in the surroundings (= in the file), null when the test does not name it.
     */
    Integer mockedMemberLine(String surroundings, String member) {
        String quoted = Pattern.quote(member);
        for (String template : rules.mockMembers()) {
            Matcher m = Pattern.compile(template.replace("{member}", quoted)).matcher(surroundings);
            if (m.find()) {
                int line = 1;
                for (int i = 0; i < m.start(); i++) {
                    if (surroundings.charAt(i) == '\n') {
                        line++;
                    }
                }
                return line;
            }
        }
        return null;
    }

    /** Collaborators replaced around the test, in order of appearance, without duplicates and without the unit. */
    List<String> mocks(String surroundings, String unit) {
        record Found(int at, String name) {
        }
        List<Found> found = new ArrayList<>();
        for (Rules.MockRule r : rules.mocks()) {
            Matcher m = r.pattern().matcher(surroundings);
            while (m.find()) {
                if (r.name() != null) {
                    found.add(new Found(m.start(), r.name()));
                    break;
                }
                Map<String, Integer> groups = m.namedGroups();
                String name = null;
                if (groups.containsKey("type") && m.group("type") != null) {
                    name = clean(m.group("type"));
                } else if (groups.containsKey("ref") && m.group("ref") != null) {
                    name = NO_COLLABORATOR.contains(m.group("ref")) ? null : resolve(m.group("ref"), surroundings);
                } else if (groups.containsKey("module") && m.group("module") != null) {
                    String module = m.group("module");
                    name = module.substring(module.lastIndexOf('/') + 1);
                } else if (m.groupCount() >= 1 && m.group(1) != null) {
                    name = clean(m.group(1));
                }
                if (name != null && !name.isBlank()) {
                    found.add(new Found(m.start(), name));
                }
            }
        }
        found.sort((a, b) -> Integer.compare(a.at(), b.at())); // stable: rule order among equal positions
        Set<String> names = new LinkedHashSet<>();
        found.forEach(f -> names.add(f.name()));
        if (unit != null) {
            String u = comparable(unit);
            names.removeIf(n -> comparable(n).equals(u));
        }
        return List.copyOf(names);
    }

    /** The declared type of a variable holding a mock, else its name with a capital first letter. */
    private static String resolve(String ref, String text) {
        String r = Pattern.quote(ref);
        List<Pattern> declarations = List.of(
                // TS / Kotlin: service: jasmine.SpyObj<PlayerService>, repo: PlayerRepository
                Pattern.compile("\\b" + r + "\\s*[!?]?\\s*:\\s*(?:[\\w$.]*(?:SpyObj|Mocked\\w*|MockProxy|DeepMocked|Partial|Mock)\\s*<\\s*)?([A-Z][\\w$]*)"),
                // Java / C#: PlayerRepository repo; (PlayerRepository repo) / = ...
                Pattern.compile("\\b([A-Z][\\w$]*)(?:<[^;=(){}]*>)?\\s+" + r + "\\s*[;=,)]"),
                Pattern.compile("\\b" + r + "\\s*(?::[^=;]+)?=\\s*(?:Mockito\\.)?(?:mock|spy)\\s*\\(\\s*([A-Z][\\w$]*)"),
                Pattern.compile("\\b" + r + "\\s*(?::[^=;]+)?=\\s*jasmine\\.createSpyObj\\s*(?:<[^>]*>)?\\s*\\(\\s*['\"`]([\\w$.-]+)"),
                Pattern.compile("\\b" + r + "\\s*=\\s*(?:TestBed\\.)?(?:inject|get)\\s*\\(\\s*([A-Z][\\w$]*)"),
                Pattern.compile("\\b" + r + "\\s*=\\s*new\\s+([A-Z][\\w$]*)"),
                Pattern.compile("\\b" + r + "\\s*:?=\\s*&?([A-Za-z_]\\w*)\\s*\\{"));
        for (Pattern p : declarations) {
            Matcher m = p.matcher(text);
            if (m.find()) {
                return clean(m.group(1));
            }
        }
        String name = clean(ref);
        return name.isEmpty() ? ref : Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }

    /** Without generics and mock/fake/stub/spy pre- and suffixes: mockPlayerRepo -> PlayerRepo, serviceSpy -> service. */
    static String clean(String name) {
        String n = name.replaceAll("<.*$", "").strip();
        String withoutPrefix = MOCK_PREFIX.matcher(n).replaceFirst("");
        String result = MOCK_SUFFIX.matcher(withoutPrefix).replaceFirst("");
        return result.isEmpty() ? n : result;
    }

    /** For comparing names across conventions: player-view, PlayerView, player_view -> playerview. */
    static String comparable(String name) {
        return name.replaceAll("[^\\p{L}\\d]", "").toLowerCase(Locale.ROOT);
    }

    // ------------------------------------------------------------------ level

    /** First level rule that holds (by = path or code, text = the glob or the matched code); null = unit. */
    private Hit level(String path, String surroundings) {
        for (Rules.LevelRule r : rules.levels()) {
            for (int i = 0; i < r.paths().size(); i++) {
                if (r.paths().get(i).matcher(path).matches()) {
                    return new Hit(r.level(), BY_PATH, r.globs().get(i));
                }
            }
            String text = find(r.code(), surroundings);
            if (text != null && find(r.unless(), surroundings) == null) {
                return new Hit(r.level(), BY_CODE, text);
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ parameterised cases

    /** Parameterised cases of a test (see the class comment). */
    public Cases cases(CodeText text, Symbol test) {
        int decl = Expectations.declarationLine(text, test);
        Cases junit = junitCases(text, test, decl);
        if (junit != null) {
            return junit;
        }
        EachTable each = SymbolExtractor.eachTable(text, decl - 1);
        if (each != null && !each.suite()) {
            StringBuilder rows = new StringBuilder();
            for (int li = each.line(); li <= each.endLine(); li++) {
                rows.append(visible(text, li)).append('\n');
            }
            return new Cases(true, eachRows(text, each), each.keyword() + ".each", rows.toString());
        }
        Cases go = goTable(text, test, decl);
        return go != null ? go : Cases.NONE;
    }

    private static Cases junitCases(CodeText text, Symbol test, int decl) {
        boolean parameterized = false;
        List<String> sources = new ArrayList<>();
        StringBuilder rows = new StringBuilder();
        int total = 0;
        boolean unknown = false;
        for (int li = test.startLine() - 1; li < decl - 1; li++) {
            Matcher m = NAME_START.matcher(text.code.get(li));
            if (!m.find()) {
                continue;
            }
            int end = SymbolExtractor.annotationEnd(text, li);
            String code = String.join("\n", text.code.subList(li, end + 1));
            String raw = String.join("\n", text.lines.subList(li, end + 1));
            String name = m.group(1).substring(m.group(1).lastIndexOf('.') + 1);
            Integer n;
            switch (name) {
                case "ParameterizedTest" -> {
                    parameterized = true;
                    li = end;
                    continue;
                }
                case "ValueSource" -> n = valueSource(code);
                case "CsvSource" -> n = csvSource(code, raw);
                case "EnumSource" -> n = enumSource(code);
                case "NullSource", "EmptySource" -> n = 1;
                case "NullAndEmptySource" -> n = 2;
                case "MethodSource", "ArgumentsSource", "CsvFileSource", "FieldSource" -> n = null;
                default -> {
                    li = end;
                    continue;
                }
            }
            sources.add("@" + name);
            rows.append(raw).append('\n');
            if (n == null) {
                unknown = true;
            } else {
                total += n;
            }
            li = end;
        }
        if (!parameterized) {
            return null;
        }
        return new Cases(true, unknown || sources.isEmpty() ? null : total,
                sources.isEmpty() ? "@ParameterizedTest" : String.join(" + ", sources), rows.toString());
    }

    /** @ValueSource(ints = {1, 2, 3}) -> 3, @ValueSource(strings = "a") -> 1. */
    private static Integer valueSource(String code) {
        Matcher m = Pattern.compile("=\\s*([{]?)").matcher(code);
        if (!m.find()) {
            return null;
        }
        return m.group(1).isEmpty() ? Integer.valueOf(1) : elements(code, m.end() - 1);
    }

    /** @CsvSource({"a, 1", "b, 2"}) -> 2, @CsvSource("a, 1") -> 1, text block: its non-blank, non-comment lines. */
    private static Integer csvSource(String code, String raw) {
        if (code.contains("textBlock")) {
            int open = raw.indexOf("\"\"\"");
            int close = open < 0 ? -1 : raw.indexOf("\"\"\"", open + 3);
            if (close < 0) {
                return null;
            }
            int rows = 0;
            for (String l : raw.substring(open + 3, close).split("\n")) {
                String t = l.strip();
                if (!t.isEmpty() && !t.startsWith("#")) {
                    rows++;
                }
            }
            return rows;
        }
        int paren = code.indexOf('(');
        int brace = code.indexOf('{', Math.max(paren, 0));
        if (brace >= 0) {
            return elements(code, brace);
        }
        return paren >= 0 && code.indexOf('"', paren) >= 0 ? 1 : null;
    }

    /** @EnumSource(value = X.class, names = {"A", "B"}) -> 2; without names or with a mode: unknown. */
    private static Integer enumSource(String code) {
        if (code.contains("mode")) {
            return null;
        }
        Matcher m = Pattern.compile("\\bnames\\s*=\\s*([{\"])").matcher(code);
        if (!m.find()) {
            return null;
        }
        return m.group(1).equals("\"") ? Integer.valueOf(1) : elements(code, m.end() - 1);
    }

    /** Rows of an it.each table: elements of a literal array, rows of a template table minus the header; else null. */
    private static Integer eachRows(CodeText text, EachTable each) {
        if (each.template()) {
            StringBuilder sb = new StringBuilder();
            for (int li = each.line(); li <= each.endLine(); li++) {
                String raw = text.lines.get(li);
                int from = li == each.line() ? each.col() + 1 : 0;
                int to = li == each.endLine() ? each.endCol() - 1 : raw.length();
                sb.append(raw, Math.min(from, raw.length()), Math.max(Math.min(to, raw.length()), Math.min(from, raw.length()))).append('\n');
            }
            int rows = 0;
            for (String l : sb.toString().split("\n")) {
                if (!l.isBlank()) {
                    rows++;
                }
            }
            return Math.max(0, rows - 1);
        }
        String code = joined(text, each.line(), each.col(), each.endLine(), each.endCol());
        int i = 1;
        while (i < code.length() && Character.isWhitespace(code.charAt(i))) {
            i++;
        }
        return i < code.length() && code.charAt(i) == '[' ? elements(code, i) : null;
    }

    /**
     * Go table test: `for _, tt := range tests {` in the body over `tests := []struct{…}{ {…}, {…} }` (or a map, or
     * a named element type) declared in the body: the number of entries.
     */
    private static Cases goTable(CodeText text, Symbol test, int decl) {
        int last = Math.min(test.endLine(), text.code.size());
        String body = String.join("\n", text.code.subList(decl - 1, last));
        Matcher range = GO_RANGE.matcher(body);
        while (range.find()) {
            String var = Pattern.quote(range.group(1));
            Matcher declaration = Pattern.compile("\\b" + var + "\\s*:?=\\s*(\\[\\]|map\\[[^\\]]*\\])\\s*(struct\\s*\\{|\\*?[\\w.]+\\s*\\{)")
                    .matcher(body);
            if (!declaration.find() || declaration.start() > range.start()) {
                continue;
            }
            int open = declaration.end() - 1;
            if (declaration.group(2).startsWith("struct")) {
                int close = matching(body, open);
                if (close < 0) {
                    continue;
                }
                open = close + 1;
                while (open < body.length() && Character.isWhitespace(body.charAt(open))) {
                    open++;
                }
                if (open >= body.length() || body.charAt(open) != '{') {
                    continue;
                }
            }
            Integer n = elements(body, open);
            if (n != null) {
                int close = matching(body, open);
                return new Cases(true, n, "table", body.substring(open, close < 0 ? body.length() : close + 1));
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ parameter tables with their values

    /** Style of a parameter table: decides how a row's display name is formed (see {@link CaseMatrices}). */
    public static final String JUNIT = "junit";
    public static final String EACH = "each";
    public static final String GO = "go";

    /**
     * The literal rows of a parameterised test. style: junit | each | go. labels: the column names - method parameters,
     * the callback parameters / object keys / header of an it.each table, the struct fields of a Go table (may be fewer
     * than the values of a row). rows: one per case, in source order. nameTemplate: the display-name pattern (JUnit
     * name = "…", the it.each name with %s / $key), null if none. rowVar: the variable a row is reached through
     * (Go: `tt` of `for _, tt := range tests`, it.each: a single callback parameter for object rows), null when the
     * values are bound to names directly. endLine: last line (1-based) of a table that sits in the test body (Go), else 0.
     */
    public record Table(String style, List<String> labels, List<TableRow> rows, String nameTemplate, String rowVar, int endLine) {
    }

    /** One row: line (1-based) where it starts, its values as written (strings with quotes, null = missing), key: the map key of a Go map table, else null. */
    public record TableRow(int line, List<String> values, String key) {
    }

    private static final Pattern GO_RANGE_VARS = Pattern.compile("\\bfor\\s+(\\w+)\\s*(?:,\\s*(\\w+)\\s*)?:=\\s*range\\s+(\\w+)\\s*\\{");
    private static final Pattern GO_FIELD = Pattern.compile("^([A-Za-z_]\\w*(?:\\s*,\\s*[A-Za-z_]\\w*)*)\\s+\\S");
    private static final Pattern GO_KEYED = Pattern.compile("^\\s*([A-Za-z_]\\w*)\\s*:(?!=)");
    private static final Pattern EACH_CALLBACK = Pattern.compile(
            "^\\s*,\\s*(?:async\\s+)?(?:function\\s*[\\w$]*\\s*)?\\(([^)]*)\\)|^\\s*,\\s*(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*=>");

    /**
     * The literal rows of a parameterised test, or null when it has none or they are not all literal (@MethodSource,
     * it.each(variable), a Go table built elsewhere, ...).
     */
    public Table table(CodeText text, Symbol test) {
        int decl = Expectations.declarationLine(text, test);
        boolean[] junit = {false};
        Table t = junitTable(text, test, decl, junit);
        if (junit[0]) {
            return t;
        }
        EachTable each = SymbolExtractor.eachTable(text, decl - 1);
        if (each != null && !each.suite()) {
            return eachValues(text, each);
        }
        return goValues(text, test, decl);
    }

    /** Text of lines from..to (0-based, inclusive) joined with "\n": code (strings blanked) and visible (strings kept). */
    private static String[] lines(CodeText text, int from, int to) {
        StringBuilder code = new StringBuilder();
        StringBuilder vis = new StringBuilder();
        for (int li = from; li <= to && li < text.code.size(); li++) {
            if (li > from) {
                code.append('\n');
                vis.append('\n');
            }
            code.append(text.code.get(li));
            vis.append(visible(text, li));
        }
        return new String[]{code.toString(), vis.toString()};
    }

    /** 1-based line of an offset in a text that starts at line first (0-based). */
    private static int lineAt(String s, int offset, int first) {
        int n = first + 1;
        for (int i = 0; i < offset && i < s.length(); i++) {
            if (s.charAt(i) == '\n') {
                n++;
            }
        }
        return n;
    }

    private static String clip(String vis, int[] piece) {
        return vis.substring(piece[0], piece[1]).replaceAll("\\s+", " ").strip();
    }

    private static Table junitTable(CodeText text, Symbol test, int decl, boolean[] parameterized) {
        List<TableRow> rows = new ArrayList<>();
        List<String> header = null;
        String nameTemplate = null;
        boolean unknown = false;
        for (int li = test.startLine() - 1; li < decl - 1; li++) {
            Matcher m = NAME_START.matcher(text.code.get(li));
            if (!m.find()) {
                continue;
            }
            int end = SymbolExtractor.annotationEnd(text, li);
            String[] both = lines(text, li, end);
            String code = both[0];
            String vis = both[1];
            String name = m.group(1).substring(m.group(1).lastIndexOf('.') + 1);
            switch (name) {
                case "ParameterizedTest" -> {
                    parameterized[0] = true;
                    Matcher n = Pattern.compile("\\bname\\s*=\\s*\"").matcher(code);
                    if (n.find()) {
                        int close = code.indexOf('"', n.end());
                        nameTemplate = close < 0 ? null : vis.substring(n.end(), close);
                    }
                }
                case "ValueSource", "EnumSource" -> {
                    Matcher v = Pattern.compile(name.equals("ValueSource") ? "=\\s*([{]?)" : "\\bnames\\s*=\\s*([{]?)").matcher(code);
                    if (!v.find() || (name.equals("EnumSource") && code.contains("mode"))) {
                        unknown = true;
                        break;
                    }
                    List<int[]> pieces;
                    if (v.group(1).isEmpty()) {
                        int close = code.lastIndexOf(')');
                        pieces = List.of(new int[]{v.end(), close < v.end() ? code.length() : close});
                    } else {
                        pieces = pieces(code, v.end() - 1);
                    }
                    if (pieces == null) {
                        unknown = true;
                        break;
                    }
                    for (int[] p : pieces) {
                        String value = clip(vis, p);
                        if (name.equals("EnumSource") && value.length() >= 2 && value.startsWith("\"")) {
                            value = value.substring(1, value.length() - 1);
                        }
                        rows.add(new TableRow(lineAt(code, p[0], li), List.of(value), null));
                    }
                }
                case "CsvSource" -> {
                    header = csvRows(text, li, code, vis, rows, header);
                    if (header == null && rows.isEmpty()) {
                        unknown = true;
                    }
                }
                case "NullSource" -> rows.add(new TableRow(li + 1, List.of("null"), null));
                case "EmptySource" -> rows.add(new TableRow(li + 1, List.of("\"\""), null));
                case "NullAndEmptySource" -> {
                    rows.add(new TableRow(li + 1, List.of("null"), null));
                    rows.add(new TableRow(li + 1, List.of("\"\""), null));
                }
                case "MethodSource", "ArgumentsSource", "CsvFileSource", "FieldSource" -> unknown = true;
                default -> {
                }
            }
            li = end;
        }
        if (!parameterized[0] || unknown || rows.isEmpty()) {
            return null;
        }
        List<String> labels = methodParameters(text, test, decl);
        if (labels.isEmpty() && header != null) {
            labels = header;
        }
        return new Table(JUNIT, labels, rows, nameTemplate, null, 0);
    }

    /**
     * The rows of a @CsvSource (array of strings, a single string or a text block), split at the delimiter outside
     * single quotes; cells as written, an empty cell is null (as JUnit reads it). Returns the header of a text block
     * with useHeadersInDisplayName = true (that line is no case), else an empty list; null when nothing was found.
     */
    private static List<String> csvRows(CodeText text, int li, String code, String vis, List<TableRow> rows, List<String> header) {
        String delimiter = ",";
        Matcher d = Pattern.compile("\\bdelimiter\\s*=\\s*'(.)'").matcher(vis);
        Matcher ds = Pattern.compile("\\bdelimiterString\\s*=\\s*\"([^\"]+)\"").matcher(vis);
        if (d.find()) {
            delimiter = d.group(1);
        } else if (ds.find()) {
            delimiter = ds.group(1);
        }
        boolean headers = Pattern.compile("\\buseHeadersInDisplayName\\s*=\\s*true").matcher(code).find();
        List<String> found = new ArrayList<>();
        List<Integer> lines = new ArrayList<>();
        int block = code.indexOf("\"\"\"");
        if (block >= 0) {
            int close = code.indexOf("\"\"\"", block + 3);
            if (close < 0) {
                return null;
            }
            int from = block + 3;
            for (String l : vis.substring(from, close).split("\n", -1)) {
                String t = l.strip();
                if (!t.isEmpty() && !t.startsWith("#")) {
                    found.add(t);
                    lines.add(lineAt(code, from, li));
                }
                from += l.length() + 1;
            }
        } else {
            int paren = code.indexOf('(');
            int brace = code.indexOf('{', Math.max(paren, 0));
            List<int[]> pieces;
            if (brace >= 0) {
                pieces = pieces(code, brace);
            } else {
                int q = paren < 0 ? -1 : code.indexOf('"', paren);
                int q2 = q < 0 ? -1 : code.indexOf('"', q + 1);
                pieces = q2 < 0 ? null : List.of(new int[]{q, q2 + 1});
            }
            if (pieces == null) {
                return null;
            }
            for (int[] p : pieces) {
                String s = vis.substring(p[0], p[1]).strip();
                if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
                    found.add(s.substring(1, s.length() - 1));
                    lines.add(lineAt(code, p[0], li));
                }
            }
        }
        List<String> head = List.of();
        for (int i = 0; i < found.size(); i++) {
            List<String> cells = csvCells(found.get(i), delimiter);
            if (headers && i == 0) {
                head = cells;
                continue;
            }
            rows.add(new TableRow(lines.get(i), cells, null));
        }
        return header != null && head.isEmpty() ? header : head;
    }

    /** Cells of one CSV line: split at the delimiter outside '…', trimmed; an empty unquoted cell is "null". */
    static List<String> csvCells(String line, String delimiter) {
        List<String> cells = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '\'') {
                quoted = !quoted;
            }
            if (!quoted && line.startsWith(delimiter, i)) {
                cells.add(cell.toString().strip());
                cell.setLength(0);
                i += delimiter.length() - 1;
                continue;
            }
            cell.append(c);
        }
        cells.add(cell.toString().strip());
        cells.replaceAll(c -> c.isEmpty() ? "null" : c);
        return cells;
    }

    /** Names of the parameters of a test method: `void x(int number, @Foo String text)` -> [number, text]; Kotlin `a: Int` too. */
    private static List<String> methodParameters(CodeText text, Symbol test, int decl) {
        String line = text.code.get(decl - 1);
        Matcher m = Pattern.compile("\\b" + Pattern.quote(test.name()) + "\\s*\\(").matcher(line);
        if (!m.find()) {
            return List.of();
        }
        int[] end = text.skipParens(decl - 1, m.end() - 1);
        if (end == null) {
            return List.of();
        }
        String params = lines(text, decl - 1, end[0])[0];
        int open = m.end() - 1;
        List<int[]> pieces = pieces(params, open);
        List<String> names = new ArrayList<>();
        if (pieces == null) {
            return names;
        }
        for (int[] p : pieces) {
            String param = params.substring(p[0], p[1]).replaceAll("@[\\w.]+(\\s*\\([^)]*\\))?", "").strip();
            int colon = param.indexOf(':');
            String part = colon >= 0 ? param.substring(0, colon) : param;
            Matcher id = Pattern.compile("([A-Za-z_$][\\w$]*)\\s*$").matcher(part.strip());
            names.add(id.find() ? id.group(1) : "");
        }
        return names;
    }

    /** The rows of an it.each table: a literal array (of arrays, objects or single values) or a template table. */
    private static Table eachValues(CodeText text, EachTable each) {
        String[] both = lines(text, each.line(), each.endLine());
        String code = both[0];
        String vis = both[1];
        int from = each.col();
        int to = code.length() - (text.code.get(each.endLine()).length() - each.endCol());
        List<TableRow> rows = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        Callback callback = eachCallback(text, each);
        String rowVar = null;
        if (each.template()) {
            List<String> header = null;
            int offset = from + 1;
            for (String l : vis.substring(from + 1, Math.max(from + 1, to - 1)).split("\n", -1)) {
                if (!l.isBlank()) {
                    List<String> cells = templateCells(l);
                    if (header == null) {
                        header = cells;
                    } else {
                        rows.add(new TableRow(lineAt(code, offset, each.line()), cells, null));
                    }
                }
                offset += l.length() + 1;
            }
            if (header == null || rows.isEmpty()) {
                return null;
            }
            labels.addAll(header);
            if (callback.names().size() == 1 && !callback.destructured()) {
                rowVar = callback.names().getFirst();
            }
        } else {
            int bracket = from + 1;
            while (bracket < code.length() && Character.isWhitespace(code.charAt(bracket))) {
                bracket++;
            }
            if (bracket >= code.length() || code.charAt(bracket) != '[') {
                return null; // it.each(variable): rows not literal
            }
            List<int[]> elements = pieces(code, bracket);
            if (elements == null || elements.isEmpty()) {
                return null;
            }
            boolean objects = code.charAt(elements.getFirst()[0]) == '{';
            for (int[] e : elements) {
                char c = code.charAt(e[0]);
                List<String> values = new ArrayList<>();
                if (c == '[' || c == '{') {
                    List<int[]> cells = pieces(code, e[0]);
                    if (cells == null) {
                        return null;
                    }
                    for (int[] cell : cells) {
                        if (c == '{') {
                            int colon = topLevelColon(code, cell[0], cell[1]);
                            String key = (colon < 0 ? vis.substring(cell[0], cell[1]) : vis.substring(cell[0], colon)).strip()
                                    .replaceAll("^['\"]|['\"]$", "");
                            String value = colon < 0 ? key : clip(vis, new int[]{colon + 1, cell[1]});
                            int k = labels.indexOf(key);
                            if (k < 0) {
                                labels.add(key);
                                k = labels.size() - 1;
                            }
                            while (values.size() <= k) {
                                values.add(null);
                            }
                            values.set(k, value);
                        } else {
                            values.add(clip(vis, cell));
                        }
                    }
                } else {
                    values.add(clip(vis, e));
                }
                rows.add(new TableRow(lineAt(code, e[0], each.line()), values, null));
            }
            if (objects) {
                if (callback.names().size() == 1 && !callback.destructured()) {
                    rowVar = callback.names().getFirst();
                }
            } else {
                labels.addAll(callback.names());
            }
        }
        int width = labels.size();
        for (TableRow r : rows) {
            width = Math.max(width, r.values().size());
        }
        List<TableRow> padded = new ArrayList<>();
        for (TableRow r : rows) {
            List<String> v = new ArrayList<>(r.values());
            while (v.size() < width) {
                v.add(null);
            }
            padded.add(new TableRow(r.line(), v, null));
        }
        return new Table(EACH, labels, padded, each.name(), rowVar, 0);
    }

    /** The cells of a template-table line: split at "|" outside ${…}; ${x} -> x. */
    private static List<String> templateCells(String line) {
        List<String> cells = new ArrayList<>();
        int depth = 0;
        StringBuilder cell = new StringBuilder();
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
            } else if (c == '|' && depth == 0 && (i + 1 >= line.length() || line.charAt(i + 1) != '|')
                    && (i == 0 || line.charAt(i - 1) != '|')) {
                cells.add(cell.toString());
                cell.setLength(0);
                continue;
            }
            cell.append(c);
        }
        cells.add(cell.toString());
        List<String> result = new ArrayList<>();
        for (String c : cells) {
            String t = c.strip();
            if (t.startsWith("${") && t.endsWith("}")) {
                t = t.substring(2, t.length() - 1).strip();
            }
            result.add(t);
        }
        return result;
    }

    /** Index of the first ":" at depth 0 in code[from, to), or -1. */
    private static int topLevelColon(String code, int from, int to) {
        int depth = 0;
        for (int i = from; i < to; i++) {
            char c = code.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
            } else if (c == ':' && depth == 0) {
                return i;
            }
        }
        return -1;
    }

    /**
     * The parameters of the callback after the name of an it.each block: `('name', async (typed, status) => …)` ->
     * [typed, status]; a destructured object or array `({ a, b }) =>` -> [a, b]; `row =>` -> [row].
     */
    private record Callback(List<String> names, boolean destructured) {
        static final Callback NONE = new Callback(List.of(), false);
    }

    private static Callback eachCallback(CodeText text, EachTable each) {
        String code = lines(text, each.endLine(), Math.min(each.endLine() + 4, text.code.size() - 1))[0];
        int i = each.endCol();
        while (i < code.length() && Character.isWhitespace(code.charAt(i))) {
            i++;
        }
        if (i >= code.length() || code.charAt(i) != '(') {
            return Callback.NONE;
        }
        i++;
        while (i < code.length() && Character.isWhitespace(code.charAt(i))) {
            i++;
        }
        if (i >= code.length() || "'\"`".indexOf(code.charAt(i)) < 0) {
            return Callback.NONE;
        }
        int close = code.indexOf(code.charAt(i), i + 1);
        if (close < 0) {
            return Callback.NONE;
        }
        Matcher m = EACH_CALLBACK.matcher(code.substring(close + 1));
        if (!m.find()) {
            return Callback.NONE;
        }
        if (m.group(2) != null) {
            return new Callback(List.of(m.group(2)), false);
        }
        String params = m.group(1).strip();
        if (params.startsWith("{") || params.startsWith("[")) {
            // destructured: the names inside are the columns
            String inner = params.replaceAll("^[\\[{]|[\\]}][^\\]}]*$", "");
            List<String> names = new ArrayList<>();
            for (String p : inner.split(",")) {
                Matcher id = Pattern.compile("^\\s*([A-Za-z_$][\\w$]*)").matcher(p);
                if (id.find()) {
                    names.add(id.group(1));
                }
            }
            return new Callback(names, true);
        }
        List<String> names = new ArrayList<>();
        for (String p : params.split(",")) {
            Matcher id = Pattern.compile("^\\s*(?:\\.\\.\\.)?([A-Za-z_$][\\w$]*)").matcher(p);
            if (id.find()) {
                names.add(id.group(1));
            }
        }
        return new Callback(names, false);
    }

    /**
     * The entries of a Go table test (see {@link #goTable}) with their values: positional entries in field order,
     * keyed entries (`name: "x"`) by field; for a map table the key of each entry.
     */
    private static Table goValues(CodeText text, Symbol test, int decl) {
        int last = Math.min(test.endLine(), text.code.size());
        String[] both = lines(text, decl - 1, last - 1);
        String body = both[0];
        String vis = both[1];
        Matcher range = GO_RANGE_VARS.matcher(body);
        while (range.find()) {
            String var = Pattern.quote(range.group(3));
            Matcher declaration = Pattern.compile("\\b" + var + "\\s*:?=\\s*(\\[\\]|map\\[[^\\]]*\\])\\s*(struct\\s*\\{|\\*?([\\w.]+)\\s*\\{)")
                    .matcher(body);
            if (!declaration.find() || declaration.start() > range.start()) {
                continue;
            }
            boolean map = declaration.group(1).startsWith("map");
            int open = declaration.end() - 1;
            List<String> fields;
            if (declaration.group(2).startsWith("struct")) {
                int close = matching(body, open);
                if (close < 0) {
                    continue;
                }
                fields = goFields(body.substring(open + 1, close));
                open = close + 1;
                while (open < body.length() && Character.isWhitespace(body.charAt(open))) {
                    open++;
                }
                if (open >= body.length() || body.charAt(open) != '{') {
                    continue;
                }
            } else {
                fields = goNamedFields(text, declaration.group(3));
            }
            List<int[]> entries = pieces(body, open);
            if (entries == null || entries.isEmpty()) {
                continue;
            }
            int tableEnd = matching(body, open);
            List<TableRow> rows = new ArrayList<>();
            List<String> labels = new ArrayList<>(fields);
            for (int[] e : entries) {
                int start = e[0];
                String key = null;
                if (map) {
                    int colon = topLevelColon(body, e[0], e[1]);
                    if (colon < 0) {
                        continue;
                    }
                    key = vis.substring(e[0], colon).strip();
                    start = colon + 1;
                }
                int brace = body.indexOf('{', start);
                if (brace < 0 || brace >= e[1]) {
                    continue;
                }
                List<int[]> cells = pieces(body, brace);
                if (cells == null) {
                    continue;
                }
                List<String> values = new ArrayList<>();
                for (int i = 0; i < cells.size(); i++) {
                    int[] cell = cells.get(i);
                    Matcher keyed = GO_KEYED.matcher(body.substring(cell[0], cell[1]));
                    int k = i;
                    int from = cell[0];
                    if (keyed.find()) {
                        k = labels.indexOf(keyed.group(1));
                        if (k < 0) {
                            labels.add(keyed.group(1));
                            k = labels.size() - 1;
                        }
                        from = cell[0] + keyed.end();
                    }
                    while (values.size() <= k) {
                        values.add(null);
                    }
                    values.set(k, clip(vis, new int[]{from, cell[1]}));
                }
                rows.add(new TableRow(lineAt(body, e[0], decl - 1), values, key));
            }
            if (rows.isEmpty()) {
                continue;
            }
            int width = labels.size();
            for (TableRow r : rows) {
                width = Math.max(width, r.values().size());
            }
            List<TableRow> padded = new ArrayList<>();
            for (TableRow r : rows) {
                List<String> v = new ArrayList<>(r.values());
                while (v.size() < width) {
                    v.add(null);
                }
                padded.add(new TableRow(r.line(), v, r.key()));
            }
            String rowVar = range.group(2) != null ? range.group(2) : null;
            return new Table(GO, labels, padded, null, rowVar,
                    tableEnd < 0 ? 0 : lineAt(body, tableEnd, decl - 1));
        }
        return null;
    }

    /** Field names of a Go struct body: `name string`, `a, b int` (embedded types and tags are skipped). */
    private static List<String> goFields(String structBody) {
        List<String> names = new ArrayList<>();
        for (String decl : structBody.split("[\n;]")) {
            Matcher m = GO_FIELD.matcher(decl.strip());
            if (m.find()) {
                for (String n : m.group(1).split(",")) {
                    names.add(n.strip());
                }
            }
        }
        return names;
    }

    /** Fields of a named struct type declared in the file (`type testCase struct {…}`). */
    private static List<String> goNamedFields(CodeText text, String type) {
        String name = type.substring(type.lastIndexOf('.') + 1);
        String all = String.join("\n", text.code);
        Matcher m = Pattern.compile("\\btype\\s+" + Pattern.quote(name) + "\\s+struct\\s*\\{").matcher(all);
        if (!m.find()) {
            return List.of();
        }
        int close = matching(all, m.end() - 1);
        return close < 0 ? List.of() : goFields(all.substring(m.end(), close));
    }

    private static String joined(CodeText text, int line, int col, int endLine, int endCol) {
        StringBuilder sb = new StringBuilder();
        for (int li = line; li <= endLine; li++) {
            String c = text.code.get(li);
            int from = li == line ? Math.min(col, c.length()) : 0;
            int to = li == endLine ? Math.min(endCol, c.length()) : c.length();
            sb.append(c, from, Math.max(from, to)).append('\n');
        }
        return sb.toString();
    }

    /**
     * The number of top-level elements of the bracket opened at index open (strings already blanked): non-empty
     * pieces between commas at depth 1, so a trailing comma does not count. Null when the bracket is not closed.
     */
    static Integer elements(String code, int open) {
        List<int[]> pieces = pieces(code, open);
        return pieces == null ? null : pieces.size();
    }

    /**
     * The top-level elements of the bracket opened at index open (strings already blanked) as [start, end) without
     * surrounding whitespace; empty pieces (a trailing comma) are left out. Null when the bracket is not closed.
     */
    static List<int[]> pieces(String code, int open) {
        List<int[]> result = new ArrayList<>();
        int depth = 0;
        int start = -1;
        int end = -1;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                depth++;
                if (depth == 1) {
                    continue;
                }
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
                if (depth == 0) {
                    if (start >= 0) {
                        result.add(new int[]{start, end});
                    }
                    return result;
                }
            } else if (c == ',' && depth == 1) {
                if (start >= 0) {
                    result.add(new int[]{start, end});
                }
                start = -1;
                continue;
            }
            if (depth >= 1 && !Character.isWhitespace(c)) {
                if (start < 0) {
                    start = i;
                }
                end = i + 1;
            }
        }
        return null;
    }

    /** Index of the bracket closing the one at open, or -1. */
    private static int matching(String code, int open) {
        int depth = 0;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
                if (depth == 0) {
                    return i;
                }
            }
        }
        return -1;
    }
}
