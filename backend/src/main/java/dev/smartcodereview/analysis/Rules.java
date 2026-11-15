package dev.smartcodereview.analysis;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.MissingNode;
import dev.smartcodereview.model.Model.DiffLine;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** Pattern-based classification rules (see resources/rules/default-rules.json). */
public final class Rules {

    /**
     * builds / divides: optional hand-written explanation of how the category is composed and split into groups;
     * when empty the category module derives it from the rules.
     * needsTests: changed functions whose main category is this one count as testable logic in the coverage view
     * ("Abdeckung"); false for trivial or mechanical code (quick wins, tests, styles, configuration). Default true.
     */
    public record CategoryDef(String id, String label, String description, String icon, String builds, String divides,
                              boolean needsTests) {
    }

    /**
     * symbols: files matched by `paths` are still split into functions/classes (e.g. tests into test cases).
     * extras: segments classified by this rule may additionally appear in architecture/frontend categories.
     * text / fileText: one pattern must occur in the segment's code / anywhere in the file.
     * scope: (concerns) "frontend" or "backend" restricts the rule to that side; null = both.
     */
    public record Rule(String id, String category, String group, String reason, List<Pattern> paths,
                       List<Pattern> lines, List<Pattern> require, Pattern symbol, List<String> kinds, String special,
                       boolean symbols, boolean extras, List<Pattern> text, List<Pattern> fileText, String scope) {

        boolean matchesPath(String path) {
            return !paths.isEmpty() && paths.stream().anyMatch(p -> p.matcher(path).matches());
        }

        boolean isLineRule() {
            return paths.isEmpty() && (!lines.isEmpty() || !kinds.isEmpty() || special != null || !text.isEmpty() || !fileText.isEmpty());
        }

        boolean textHolds(String segmentText, String fileText) {
            if (!text.isEmpty() && (segmentText == null || text.stream().noneMatch(p -> p.matcher(segmentText).find()))) {
                return false;
            }
            return this.fileText.isEmpty() || (fileText != null && this.fileText.stream().anyMatch(p -> p.matcher(fileText).find()));
        }
    }

    /**
     * A collaborator replaced in a test (rules "testProfile.mocks"): a regex with a named group "type" (the name),
     * "ref" (a variable holding a mock, resolved to its declared type) or "module" (a module path, its last segment
     * counts); or, with name set, a regex that adds this fixed name ("HTTP").
     */
    public record MockRule(Pattern pattern, String name) {
    }

    /**
     * A test level (rules "testProfile.levels"): applies when a glob of paths matches the test file, or one of the
     * code patterns occurs around the test and none of unless does.
     */
    public record LevelRule(String level, List<String> globs, List<Pattern> paths, List<Pattern> code, List<Pattern> unless) {
    }

    /**
     * Test-Steckbrief (see {@link TestProfiles}), rules section "testProfile". errorCode: regexes searched in the test
     * (head and body, comments removed, string contents kept). edgeCode: regexes searched only in the inputs of the
     * code under test - the parameter sources (@ValueSource, @CsvSource, @NullSource, it.each table, Go table) and the
     * argument lists of calls to the targets and of the inputCalls. inputCalls: regexes ending at the "(" of a call
     * whose arguments are inputs (HTTP requests: given().body(, http.put(, …). errorName / edgeName: regexes searched
     * in the test name split into lower-case words. assertionKinds: kind -> regexes on an assertion statement,
     * checked in this order (existence additionally takes "weakAssertions"). A rules file without the section or
     * without one of its keys uses the built-in value for that key.
     */
    public record TestProfileRules(List<Pattern> errorCode, List<Pattern> errorName, List<Pattern> edgeName,
                                   List<Pattern> edgeCode, List<Pattern> inputCalls, Map<String, List<Pattern>> assertionKinds,
                                   List<MockRule> mocks, List<LevelRule> levels) {
    }

    /**
     * Fallmatrix (see {@link CaseMatrices}), rules section "caseMatrix". expectedNames: regexes on the name of a table
     * column (method / callback parameter, struct field, table header); a match makes it an expected column. nameFields:
     * regexes on Go struct field names that hold the name of a case (shown as the row name, not as a column). A rules
     * file without the section or without one of its keys uses the built-in value for that key.
     */
    public record CaseMatrixRules(List<Pattern> expectedNames, List<Pattern> nameFields) {
    }

    /**
     * Bestehende Tests (see {@link RelatedTests}), rules section "relatedTests". limit: at most this many existing test
     * files are loaded per pull request. mirrors: where the tests of a source directory live - the first occurrence of
     * the path segment(s) `from` in the directory is replaced by `to` (src/main/ -> src/test/); the directory itself
     * always counts. A rules file without the section or without one of its keys uses the built-in value for that key.
     */
    public record RelatedTestRules(int limit, List<Mirror> mirrors) {
    }

    /** A source directory prefix and the test directory prefix that mirrors it (rules "relatedTests.mirrors"). */
    public record Mirror(String from, String to) {
    }

    /** Lines that never make a difference: blank, braces/brackets only, comments. */
    private static final Pattern TRIVIAL = Pattern.compile(
            "^\\s*$|^\\s*[{}()\\[\\];,]*\\s*$|^\\s*(//|/\\*|\\*|\\*/|#).*$|^\\s*\\}\\s*(else\\b.*)?\\{?\\s*$");

    /** Lines that look like markup (HTML/JSX): tags, closing tags, attribute lines. */
    private static final Pattern MARKUP = Pattern.compile("^\\s*(</?[A-Za-z][\\w.:-]*|/?>|\\{/\\*|[\\w:@*\\[\\]().#-]+=\\s*[\"'{]).*$");

    public final List<CategoryDef> categories;
    public final List<Rule> rules;
    /** Frontend aspect rules: give frontend segments one extra category (first match wins). */
    public final List<Rule> aspects;
    /** Cross-cutting concerns (security, messaging, transactions, persistence): every matching rule adds a category. */
    public final List<Rule> concerns;
    /**
     * Changed expectations in tests (see {@link Expectations}): "assertions" = a line of test code that checks
     * something (expect(…), assertEquals(…), verify(…), t.Error…); "weakAssertions" = an assertion that only checks
     * existence or truthiness; "disabledTests" = a test or suite that is switched off (xit, it.skip, @Disabled,
     * t.Skip). All are regexes, searched (find) in the code with string contents and comments blanked out. A rules
     * file without one of these sections uses the built-in default for it.
     */
    public final List<Pattern> assertions;
    public final List<Pattern> weakAssertions;
    public final List<Pattern> disabledTests;
    /** Test-Steckbrief: scenario, assertion kinds, mocks and level of a test case (see {@link TestProfileRules}). */
    public final TestProfileRules testProfile;
    /** Fallmatrix: which table columns are expectations and which hold case names (see {@link CaseMatrixRules}). */
    public final CaseMatrixRules caseMatrix;
    /** Bestehende Tests: how many existing test files are loaded and where tests live (see {@link RelatedTestRules}). */
    public final RelatedTestRules relatedTests;
    public final String hash;

    private Rules(List<CategoryDef> categories, List<Rule> rules, List<Rule> aspects, List<Rule> concerns,
                  List<Pattern> assertions, List<Pattern> weakAssertions, List<Pattern> disabledTests,
                  TestProfileRules testProfile, CaseMatrixRules caseMatrix, RelatedTestRules relatedTests, String hash) {
        this.categories = categories;
        this.rules = rules;
        this.aspects = aspects;
        this.concerns = concerns;
        this.assertions = assertions;
        this.weakAssertions = weakAssertions;
        this.disabledTests = disabledTests;
        this.testProfile = testProfile;
        this.caseMatrix = caseMatrix;
        this.relatedTests = relatedTests;
        this.hash = hash;
    }

    public static Rules parse(JsonNode root, String hash) {
        List<CategoryDef> categories = new ArrayList<>();
        for (JsonNode c : root.path("categories")) {
            categories.add(new CategoryDef(c.path("id").asText(), c.path("label").asText(),
                    c.path("description").asText(""), c.path("icon").asText("code"),
                    c.path("builds").asText(""), c.path("divides").asText(""), c.path("needsTests").asBoolean(true)));
        }
        return new Rules(categories, rules(root.path("rules")), rules(root.path("aspects")), rules(root.path("concerns")),
                section(root, "assertions"), section(root, "weakAssertions"), section(root, "disabledTests"),
                testProfile(root.path("testProfile")), caseMatrix(root.path("caseMatrix")),
                relatedTests(root.path("relatedTests")), hash);
    }

    /** The "relatedTests" section; every missing key is taken from the built-in rules. */
    private static RelatedTestRules relatedTests(JsonNode node) {
        JsonNode builtIn = defaults().path("relatedTests");
        java.util.function.Function<String, JsonNode> key = k -> node.has(k) ? node.get(k) : builtIn.path(k);
        List<Mirror> mirrors = new ArrayList<>();
        for (JsonNode m : key.apply("mirrors")) {
            mirrors.add(new Mirror(m.path("from").asText(), m.path("to").asText()));
        }
        return new RelatedTestRules(Math.max(0, key.apply("limit").asInt(30)), mirrors);
    }

    /** The "caseMatrix" section; every missing key is taken from the built-in rules. */
    private static CaseMatrixRules caseMatrix(JsonNode node) {
        JsonNode builtIn = defaults().path("caseMatrix");
        java.util.function.Function<String, JsonNode> key = k -> node.has(k) ? node.get(k) : builtIn.path(k);
        return new CaseMatrixRules(patterns(key.apply("expectedNames"), false), patterns(key.apply("nameFields"), false));
    }

    /** The "testProfile" section; every missing key is taken from the built-in rules. */
    private static TestProfileRules testProfile(JsonNode node) {
        JsonNode builtIn = defaults().path("testProfile");
        java.util.function.Function<String, JsonNode> key = k -> node.has(k) ? node.get(k) : builtIn.path(k);
        Map<String, List<Pattern>> kinds = new LinkedHashMap<>();
        key.apply("assertionKinds").properties().forEach(e -> kinds.put(e.getKey(), patterns(e.getValue(), false)));
        List<MockRule> mocks = new ArrayList<>();
        for (JsonNode m : key.apply("mocks")) {
            mocks.add(m.isObject() ? new MockRule(Pattern.compile(m.path("pattern").asText()), m.path("name").asText(null))
                    : new MockRule(Pattern.compile(m.asText()), null));
        }
        List<LevelRule> levels = new ArrayList<>();
        for (JsonNode l : key.apply("levels")) {
            levels.add(new LevelRule(l.path("level").asText(), strings(l.path("paths")), patterns(l.path("paths"), true),
                    patterns(l.path("code"), false), patterns(l.path("unless"), false)));
        }
        return new TestProfileRules(patterns(key.apply("errorCode"), false), patterns(key.apply("errorName"), false),
                patterns(key.apply("edgeName"), false), patterns(key.apply("edgeCode"), false),
                patterns(key.apply("inputCalls"), false), kinds, mocks, levels);
    }

    /** A list of regexes; taken from the built-in rules when the given rules file has no such section. */
    private static List<Pattern> section(JsonNode root, String name) {
        JsonNode node = root.get(name);
        if (node == null || !node.isArray()) {
            node = defaults().path(name);
        }
        return patterns(node, false);
    }

    private static volatile JsonNode defaults;

    private static JsonNode defaults() {
        JsonNode d = defaults;
        if (d == null) {
            try (InputStream in = Rules.class.getResourceAsStream("/rules/default-rules.json")) {
                d = in == null ? MissingNode.getInstance() : new ObjectMapper().readTree(in);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            defaults = d;
        }
        return d;
    }

    private static List<Rule> rules(JsonNode array) {
        List<Rule> rules = new ArrayList<>();
        for (JsonNode r : array) {
            rules.add(new Rule(r.path("id").asText(), r.path("category").asText("quick-wins"),
                    r.path("group").asText(r.path("id").asText()), r.path("reason").asText(""),
                    patterns(r.path("paths"), true), patterns(r.path("lines"), false), patterns(r.path("require"), false),
                    r.hasNonNull("symbol") ? Pattern.compile(r.get("symbol").asText()) : null,
                    strings(r.path("kinds")), r.path("special").asText(null), r.path("symbols").asBoolean(false),
                    r.path("extras").asBoolean(true), patterns(r.path("text"), false), patterns(r.path("fileText"), false),
                    r.path("scope").asText(null)));
        }
        return rules;
    }

    private static List<String> strings(JsonNode array) {
        List<String> result = new ArrayList<>();
        array.forEach(n -> result.add(n.asText()));
        return result;
    }

    private static List<Pattern> patterns(JsonNode array, boolean glob) {
        List<Pattern> result = new ArrayList<>();
        for (JsonNode n : array) {
            result.add(glob ? Pattern.compile(globToRegex(n.asText())) : Pattern.compile(n.asText()));
        }
        return result;
    }

    /** `**` spans directories, `*` and `?` stay within one path segment. A leading `** /` also matches the root. */
    static String globToRegex(String glob) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < glob.length(); i++) {
            char c = glob.charAt(i);
            if (c == '*' && i + 1 < glob.length() && glob.charAt(i + 1) == '*') {
                if (i + 2 < glob.length() && glob.charAt(i + 2) == '/') {
                    sb.append("(?:.*/)?");
                    i += 2;
                } else {
                    sb.append(".*");
                    i++;
                }
            } else if (c == '*') {
                sb.append("[^/]*");
            } else if (c == '?') {
                sb.append("[^/]");
            } else if ("\\.[]{}()+-^$|".indexOf(c) >= 0) {
                sb.append('\\').append(c);
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** Does changed code of this (main) category need tests? Categories the rules file does not define do. */
    public boolean needsTests(String categoryId) {
        return categories.stream().filter(c -> c.id().equals(categoryId)).findFirst().map(CategoryDef::needsTests).orElse(true);
    }

    /** First path rule that matches the file, or null. */
    public Rule forPath(String path) {
        for (Rule r : rules) {
            if (r.matchesPath(path)) {
                return r;
            }
        }
        return null;
    }

    public Rule forLines(Collection<DiffLine> changed, String symbolName, String symbolKind) {
        return forLines(changed, symbolName, symbolKind, null, null);
    }

    /**
     * First segment rule that matches, or null. A rule matches when its symbol name/kind and text filters fit
     * and all changed lines match its line patterns (a rule with only kinds/text filters needs no line patterns).
     */
    public Rule forLines(Collection<DiffLine> changed, String symbolName, String symbolKind, String segmentText, String fileText) {
        for (Rule r : rules) {
            if (!r.isLineRule()) {
                continue;
            }
            if (r.symbol() != null && (symbolName == null || !r.symbol().matcher(symbolName).find())) {
                continue;
            }
            if (!r.kinds().isEmpty() && (symbolKind == null || !r.kinds().contains(symbolKind))) {
                continue;
            }
            if (!r.textHolds(segmentText, fileText)) {
                continue;
            }
            if (r.lines().isEmpty() && r.special() == null) {
                return r;
            }
            if ("same-content".equals(r.special())) {
                if (sameContent(changed)) {
                    return r;
                }
                continue;
            }
            if (allLinesMatch(r, changed)) {
                return r;
            }
        }
        return null;
    }

    /**
     * First aspect rule whose conditions all hold (each given list needs one match): path glob, symbol kind/name,
     * a pattern in the segment's code, a pattern in the whole file, special "markup" (mostly HTML/JSX lines).
     */
    public Rule aspectFor(String path, String symbolName, String symbolKind, String segmentText, String fileText,
                          Collection<DiffLine> changed) {
        for (Rule r : aspects) {
            if (!r.paths().isEmpty() && !r.matchesPath(path)) {
                continue;
            }
            if (!r.kinds().isEmpty() && (symbolKind == null || !r.kinds().contains(symbolKind))) {
                continue;
            }
            if (r.symbol() != null && (symbolName == null || !r.symbol().matcher(symbolName).find())) {
                continue;
            }
            if (!r.textHolds(segmentText, fileText)) {
                continue;
            }
            if ("markup".equals(r.special()) && !mostlyMarkup(changed)) {
                continue;
            }
            return r;
        }
        return null;
    }

    /**
     * Categories of all concern rules that hold for a segment (path glob, symbol kind/name, pattern in the
     * segment's code / in the file, scope frontend/backend), in rule order without duplicates.
     */
    public List<String> concernsFor(String path, boolean frontend, String symbolName, String symbolKind, String segmentText,
                                    String fileText) {
        List<String> result = new ArrayList<>();
        for (Rule r : concerns) {
            if (result.contains(r.category())
                    || ("frontend".equals(r.scope()) && !frontend) || ("backend".equals(r.scope()) && frontend)) {
                continue;
            }
            if (!r.paths().isEmpty() && !r.matchesPath(path)) {
                continue;
            }
            if (!r.kinds().isEmpty() && (symbolKind == null || !r.kinds().contains(symbolKind))) {
                continue;
            }
            if (r.symbol() != null && (symbolName == null || !r.symbol().matcher(symbolName).find())) {
                continue;
            }
            if (r.textHolds(segmentText, fileText)) {
                result.add(r.category());
            }
        }
        return result;
    }

    private static boolean mostlyMarkup(Collection<DiffLine> changed) {
        int markup = 0, code = 0;
        for (DiffLine l : changed) {
            if (TRIVIAL.matcher(l.text()).matches()) {
                continue;
            }
            if (MARKUP.matcher(l.text()).matches()) {
                markup++;
            } else {
                code++;
            }
        }
        return markup > 0 && markup >= code;
    }

    private static boolean allLinesMatch(Rule r, Collection<DiffLine> changed) {
        boolean required = r.require().isEmpty();
        boolean anyNonTrivial = false;
        for (DiffLine l : changed) {
            String t = l.text();
            if (!required && r.require().stream().anyMatch(p -> p.matcher(t).find())) {
                required = true;
            }
            if (TRIVIAL.matcher(t).matches()) {
                continue;
            }
            anyNonTrivial = true;
            if (r.lines().stream().noneMatch(p -> p.matcher(t).matches())) {
                return false;
            }
        }
        return anyNonTrivial && required;
    }

    /** Added and removed lines are the same apart from whitespace and order (reformatting, moved code). */
    private static boolean sameContent(Collection<DiffLine> changed) {
        Map<String, Integer> balance = new HashMap<>();
        int adds = 0, dels = 0;
        for (DiffLine l : changed) {
            String norm = l.text().replaceAll("\\s+", "");
            if (norm.isEmpty()) {
                continue;
            }
            if ("add".equals(l.type())) {
                adds++;
                balance.merge(norm, 1, Integer::sum);
            } else {
                dels++;
                balance.merge(norm, -1, Integer::sum);
            }
        }
        return adds > 0 && dels > 0 && balance.values().stream().allMatch(v -> v == 0);
    }

    public static boolean isTrivial(String text) {
        return TRIVIAL.matcher(text).matches();
    }
}
