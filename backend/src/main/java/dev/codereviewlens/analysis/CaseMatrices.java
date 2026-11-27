package dev.codereviewlens.analysis;

import dev.codereviewlens.analysis.Expectations.Assertion;
import dev.codereviewlens.analysis.SymbolExtractor.Symbol;
import dev.codereviewlens.analysis.TestProfiles.Table;
import dev.codereviewlens.analysis.TestProfiles.TableRow;
import dev.codereviewlens.analysis.TestProfiles.TestText;
import dev.codereviewlens.model.Model.CaseColumn;
import dev.codereviewlens.model.Model.CaseMatrix;
import dev.codereviewlens.model.Model.CaseRow;
import dev.codereviewlens.model.Model.DiffFile;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fallmatrix: near-identical tests (copied, one value changed) and parameterised tests as a table input → expected,
 * with duplicate cases and the covered input values. Deterministic, token-based, no AI:
 * <ol>
 *   <li><b>Scope:</b> all test cases of the changed test files (unchanged ones too, so a new test that repeats an
 *       existing one is caught). A matrix needs at least one row with changed lines.</li>
 *   <li><b>Tokens:</b> the test body ({@link TestProfiles#read}) is split into identifiers, punctuation and literals
 *       (numbers incl. a leading minus, strings, chars, template literals without ${…}, true/false, null/nil/undefined/
 *       None).</li>
 *   <li><b>Inputs and expectations:</b> each assertion statement ({@link Expectations}) is split into what it looks at
 *       (input side) and what it expects. Chained matchers (`.statusCode(200)`, `.body("x", equalTo(7))`,
 *       `.expectNone(url)`): the text before them is input; each chained call that is itself an assertion is an
 *       expectation (its last argument is the expected value), the chain stops at the first other call with arguments
 *       (`.flush(…)` after `expectOne` is input again). `expect(x)` / `assertThat(x)` / `verify(m)` followed by
 *       matchers: the call is input, the matcher chain (`.not.toBe(3)`) the expectation with the arguments of its last
 *       call as value. Equality family (assertEquals, testify Equal, hamcrest assertThat(actual, matcher)): the actual
 *       argument is input, the expected argument the value. Other assertions (assertTrue(x), assertNull(x),
 *       assertThrows(E.class, …)): the arguments are input (a lone string literal is a message), the assertion name is
 *       the value. Infix (Kotest `x shouldBe 3`): left side input, right side the value.</li>
 *   <li><b>Similar tests:</b> tests of the same suite whose input tokens are identical once every literal is masked
 *       (the input skeleton) form a group (≥ 2 tests). The assertions may differ. Input columns = the literal positions
 *       whose value differs in at least two tests (literals equal everywhere are template). Expected columns =
 *       expectations aligned by key (the input side of the assertion with literals masked, plus the matcher; the n-th
 *       repetition of a key in a test is its own key), kept unless every test has it with the same value.
 *       Parameterised tests are never grouped this way.</li>
 *   <li><b>Parameterised tests:</b> one matrix per test with ≥ 2 literal rows ({@link TestProfiles#table}). A column is
 *       "expected" when its name matches a rules pattern (caseMatrix.expectedNames) or the name is used only inside the
 *       expectation parts of the body; else "input". Go fields matching caseMatrix.nameFields name the row.</li>
 *   <li><b>Labels:</b> input slots by their nearest context - `name =` / `name :=`, `key:`, else the enclosing call and
 *       argument position (`putJerseyNumber(…) Arg 1`), else "Wert n"; expected columns by what is checked
 *       (`statusCode`, a `.body("path", …)` path, `expect(el.textContent)`, the actual argument), shortened.</li>
 *   <li><b>Findings:</b> a row whose input values equal those of an earlier row is a duplicate of it; contradictory when
 *       both rows expect different values in some column. Per input column the distinct values, sorted (numbers
 *       numerically).</li>
 * </ol>
 * Limits: a value computed in a helper or kept in a variable declared elsewhere is not seen; expectations written as
 * `if (got != 3) t.Errorf(…)` count the 3 as an input.
 */
public final class CaseMatrices {

    public static final String SIMILAR = "similar";
    public static final String PARAMETERIZED = "parameterized";
    public static final String INPUT = "input";
    public static final String EXPECTED = "expected";
    /** The value of an assertion that has no expected value (assertNull(x), verify(repo)). */
    public static final String CHECKED = "✓";

    private static final int MAX_LABEL = 40;
    private static final int MAX_VALUE = 120;
    private static final int MAX_TEMPLATE_LINES = 40;
    private static final Set<String> LITERAL_WORDS = Set.of("true", "false", "null", "nil", "undefined", "None", "True", "False");
    /** Words before "(" that are no call (a slot inside `if (…)` gets no call label). */
    private static final Set<String> NO_CALL = Set.of("if", "while", "for", "switch", "catch", "return", "synchronized",
            "when", "assert", "typeof", "await", "yield", "throw", "else", "do", "try");
    /** Words after which a "-" starts a negative number (not a subtraction). */
    private static final Set<String> NOT_A_VALUE = Set.of("return", "case", "yield", "throw", "await", "in", "of", "typeof",
            "else", "do", "new");
    private static final Pattern NUMBER = Pattern.compile(
            "(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?|\\.\\d+(?:[eE][+-]?\\d+)?)[lLfFdDnuU]*");
    private static final Pattern NUMERIC = Pattern.compile("-?(?:\\d[\\d_]*(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?[lLfFdD]?");
    private static final Pattern DOLLAR_NAME = Pattern.compile("\\$([A-Za-z_][\\w]*)");

    private final Rules rules;
    private final TestProfiles profiles;

    public CaseMatrices(Rules rules) {
        this.rules = rules;
        this.profiles = new TestProfiles(rules);
    }

    /**
     * The matrices of all changed test files (not removed ones; files whose new version is missing are skipped), by
     * path and first line, numbered m1, m2, …
     */
    public List<CaseMatrix> all(List<DiffFile> files, Map<String, String> sources, Specs.SegmentLookup segments) {
        List<CaseMatrix> found = new ArrayList<>();
        for (DiffFile f : files) {
            String source = sources.get(f.path());
            if (source != null && Specs.isTestFile(rules, f) && !Specs.REMOVED.equals(f.status())) {
                found.addAll(of(f.path(), source, segments));
            }
        }
        found.sort(Comparator.comparing(CaseMatrix::path).thenComparingInt(CaseMatrices::firstLine));
        List<CaseMatrix> result = new ArrayList<>();
        for (int i = 0; i < found.size(); i++) {
            CaseMatrix m = found.get(i);
            result.add(new CaseMatrix("m" + (i + 1), m.path(), m.title(), m.kind(), m.template(), m.columns(), m.rows()));
        }
        return result;
    }

    private static int firstLine(CaseMatrix m) {
        return m.rows().stream().map(CaseRow::line).filter(Objects::nonNull).min(Integer::compare).orElse(0);
    }

    /** The matrices of one test file (without ids), in file order: parameterised tests, then groups of similar tests. */
    public List<CaseMatrix> of(String path, String source, Specs.SegmentLookup segments) {
        CodeText text = CodeText.of(source);
        List<Symbol> symbols = SymbolExtractor.extract(text, path);
        List<CaseMatrix> result = new ArrayList<>();
        Map<String, List<Case>> groups = new LinkedHashMap<>();
        for (Symbol s : symbols) {
            if (!"test".equals(s.kind())) {
                continue;
            }
            String segment = segments.segmentOf(path, s);
            boolean parameterized = profiles.cases(text, s).parameterized();
            if (parameterized && segment == null) {
                continue;
            }
            Body body = body(text, symbols, s);
            if (parameterized) {
                Table table = profiles.table(text, s);
                if (table != null && table.rows().size() >= 2) {
                    result.add(parameterized(path, s, segment, table, body));
                }
                continue;
            }
            if (!body.hasCall()) {
                continue;
            }
            String key = (s.container() == null ? "" : s.container()) + "\u0001" + body.skeletonKey();
            groups.computeIfAbsent(key, k -> new ArrayList<>())
                    .add(new Case(s, segment, Expectations.declarationLine(text, s), body));
        }
        for (List<Case> g : groups.values()) {
            if (g.size() >= 2 && g.stream().anyMatch(c -> c.segment() != null)) {
                result.add(similar(path, g));
            }
        }
        return result;
    }

    // ------------------------------------------------------------------ the body: tokens, inputs, expectations

    /** A token: its text as written, offsets [start, end) in the body, literal = a value that may become a column. */
    private record Tok(String text, int start, int end, boolean literal) {
        boolean ident() {
            return !literal && Character.isJavaIdentifierStart(text.charAt(0));
        }
    }

    /**
     * An expectation of an assertion. key: what is checked (input side with literals masked + matcher), label: shown
     * as column name, value: the expected value as written (or ✓ / the assertion name), [start, end): the value in
     * the body (start -1 = no place).
     */
    private record Expect(String key, String label, String value, int start, int end) {
    }

    /** A call or property in a chain: `.name(…)` (open/close: the parentheses) or `.name` (open = -1). */
    private record Link(String name, int start, int end, int open, int close) {
    }

    private record Case(Symbol symbol, String segment, int line, Body body) {
    }

    private static final class Body {
        final String vis;
        final String code;
        final int firstLine;
        final int[] lineStarts;
        final List<Tok> toks;
        final List<int[]> expectRanges = new ArrayList<>();
        final List<Expect> expects = new ArrayList<>();
        private List<Tok> skeleton;

        Body(String vis, String code, int firstLine) {
            this.vis = vis;
            this.code = code;
            this.firstLine = firstLine;
            List<Integer> starts = new ArrayList<>();
            starts.add(0);
            for (int i = 0; i < vis.length(); i++) {
                if (vis.charAt(i) == '\n' && i + 1 < vis.length()) {
                    starts.add(i + 1);
                }
            }
            this.lineStarts = starts.stream().mapToInt(Integer::intValue).toArray();
            this.toks = tokens(vis, code);
        }

        int lineStart(int index) {
            return lineStarts[index];
        }

        int lineEnd(int index) {
            int end = index + 1 < lineStarts.length ? lineStarts[index + 1] - 1 : vis.length();
            return Math.max(lineStarts[index], end);
        }

        boolean inExpectation(int offset) {
            for (int[] r : expectRanges) {
                if (offset >= r[0] && offset < r[1]) {
                    return true;
                }
            }
            return false;
        }

        /** The tokens outside the expectations: what the test feeds the code under test. */
        List<Tok> skeleton() {
            if (skeleton == null) {
                skeleton = toks.stream().filter(t -> !inExpectation(t.start())).toList();
            }
            return skeleton;
        }

        String skeletonKey() {
            StringBuilder sb = new StringBuilder();
            for (Tok t : skeleton()) {
                sb.append(t.literal() ? "\u0002" : t.text()).append('\u0000');
            }
            return sb.toString();
        }

        List<Tok> literals() {
            return skeleton().stream().filter(Tok::literal).toList();
        }

        /** At least one call outside the expectations (an empty or pure-assertion body is no case). */
        boolean hasCall() {
            List<Tok> s = skeleton();
            for (int i = 0; i + 1 < s.size(); i++) {
                if (s.get(i).ident() && s.get(i + 1).text().equals("(")) {
                    return true;
                }
            }
            return false;
        }

        /** The tokens in [from, to) joined, literals masked as ‹›. */
        String masked(int from, int to) {
            StringBuilder sb = new StringBuilder();
            for (Tok t : toks) {
                if (t.start() >= from && t.start() < to) {
                    sb.append(t.literal() ? "‹›" : t.text());
                }
            }
            return sb.toString();
        }

        String raw(int from, int to) {
            return collapse(vis.substring(from, Math.max(from, to)));
        }

        /** Exactly one token in [from, to), and it is a string literal. */
        boolean isString(int[] range) {
            Tok only = null;
            for (Tok t : toks) {
                if (t.start() >= range[0] && t.start() < range[1]) {
                    if (only != null) {
                        return false;
                    }
                    only = t;
                }
            }
            return only != null && only.literal() && "'\"`".indexOf(only.text().charAt(0)) >= 0;
        }
    }

    private Body body(CodeText text, List<Symbol> symbols, Symbol test) {
        TestText t = profiles.read(text, symbols, test, List.of());
        Body b = new Body(t.body(), t.bodyCode(), t.bodyLine());
        for (Assertion a : t.assertions()) {
            int from = Math.max(a.line(), t.bodyLine()) - t.bodyLine();
            int to = Math.min(a.endLine() - t.bodyLine(), b.lineStarts.length - 1);
            if (to < from || from >= b.lineStarts.length) {
                continue;
            }
            split(b, b.lineStart(from), b.lineEnd(to));
        }
        return b;
    }

    /** Splits the assertion statement in [rs, re) into its input side and its expectations (see the class comment). */
    private void split(Body b, int rs, int re) {
        Matcher m = firstAssertion(b.code.substring(rs, re));
        if (m == null) {
            return;
        }
        int s = skipSpace(b.code, rs + m.start(), re);
        if (s >= re) {
            return;
        }
        if (b.code.charAt(s) == '.') {
            chained(b, rs, s, re);
            return;
        }
        int i = s;
        while (i < re && (Character.isJavaIdentifierPart(b.code.charAt(i)) || b.code.charAt(i) == '.')) {
            i++;
        }
        String callee = b.code.substring(s, i);
        int j = skipSpace(b.code, i, re);
        if (j < re && b.code.charAt(j) == '<') {
            int gt = b.code.indexOf('>', j);
            j = gt < 0 || gt >= re ? j : skipSpace(b.code, gt + 1, re);
        }
        if (j >= re || b.code.charAt(j) != '(') {
            // infix matcher (Kotest: x shouldBe 3): the left side is input, the right side the value
            int[] value = trimmed(b.code, i, re);
            b.expectRanges.add(new int[]{s, re});
            b.expects.add(new Expect(b.masked(rs, s) + " " + callee, label(b.raw(rs, s)),
                    value == null ? CHECKED : value(b, value), value == null ? -1 : value[0], value == null ? -1 : value[1]));
            return;
        }
        int close = matching(b.code, j, re);
        List<int[]> args = close < 0 ? null : TestProfiles.pieces(b.code, j);
        if (args == null) {
            return;
        }
        boolean goHandle = !args.isEmpty() && Expectations.GO_HANDLE.matcher(b.code.substring(args.getFirst()[0], args.getFirst()[1])).matches();
        List<int[]> real = goHandle ? args.subList(1, args.size()) : args;
        String name = callee.substring(callee.lastIndexOf('.') + 1);
        boolean equality = Expectations.EQUALITY.matcher(name).matches()
                && (name.startsWith("assert") || !callee.contains(".") || goHandle);
        if (equality && real.size() >= 2) {
            boolean messageFirst = real.size() >= 3 && b.isString(real.getFirst());
            expectArgument(b, callee, s, close, real.get(messageFirst ? 2 : 1), real.get(messageFirst ? 1 : 0));
            return;
        }
        // matchers chained to the call: expect(x).not.toBe(y), assertThat(x).isEqualTo(y), verify(repo).save(x)
        List<Link> chain = chain(b.code, close + 1, re);
        Link last = null;
        for (Link l : chain) {
            if (l.open() >= 0) {
                last = l;
            }
        }
        if (last != null) {
            int end = last.end();
            b.expectRanges.add(new int[]{close + 1, end});
            StringBuilder names = new StringBuilder();
            for (Link l : chain) {
                if (l.start() >= end) {
                    break;
                }
                names.append('.').append(l.name());
            }
            int[] value = trimmed(b.code, last.open() + 1, last.close());
            b.expects.add(new Expect(b.masked(s, close + 1) + names, label(b.raw(s, close + 1)),
                    value == null ? CHECKED : value(b, value), value == null ? -1 : value[0], value == null ? -1 : value[1]));
            return;
        }
        if (name.equals("assertThat") && real.size() >= 2) {
            // hamcrest: assertThat([reason,] actual, matcher)
            expectArgument(b, callee, s, close, real.get(real.size() - 2), real.getLast());
            return;
        }
        // the assertion itself is the expectation (assertTrue(x), assertNull(x), assertThrows(E.class, () -> …)): its
        // arguments are inputs, apart from a message (a lone string literal next to other arguments)
        List<int[]> inputs = new ArrayList<>();
        for (int[] a : real) {
            if (!(real.size() > 1 && b.isString(a))) {
                inputs.add(a);
            }
        }
        int at = s;
        for (int[] a : inputs) {
            b.expectRanges.add(new int[]{at, a[0]});
            at = a[1];
        }
        b.expectRanges.add(new int[]{at, close + 1});
        StringBuilder key = new StringBuilder("call:");
        List<String> raw = new ArrayList<>();
        for (int[] a : inputs) {
            key.append(b.masked(a[0], a[1])).append(',');
            raw.add(b.raw(a[0], a[1]));
        }
        b.expects.add(new Expect(key.toString(), label(raw.isEmpty() ? callee : String.join(", ", raw)),
                inputs.isEmpty() ? CHECKED : name, -1, -1));
    }

    /** An assertion with an actual and an expected argument: the actual one is input, the rest of the call expectation. */
    private static void expectArgument(Body b, String callee, int s, int close, int[] actual, int[] expected) {
        b.expectRanges.add(new int[]{s, actual[0]});
        b.expectRanges.add(new int[]{actual[1], close + 1});
        b.expects.add(new Expect(callee + "=" + b.masked(actual[0], actual[1]), label(b.raw(actual[0], actual[1])),
                value(b, expected), expected[0], expected[1]));
    }

    /**
     * A chained assertion starting at s (`.statusCode(200).body("x", equalTo(7))`): every chained call that is an
     * assertion itself is an expectation; calls without arguments and properties are passed over; the first other
     * call with arguments ends the expectations (`.expectOne(url).flush(…)`: the flush is input).
     */
    private void chained(Body b, int rs, int s, int re) {
        String actual = b.masked(rs, s);
        List<Link> chain = chain(b.code, s, re);
        int end = s;
        for (int k = 0; k < chain.size(); k++) {
            Link l = chain.get(k);
            boolean hasArgs = l.open() >= 0 && trimmed(b.code, l.open() + 1, l.close()) != null;
            boolean assertion = l.open() >= 0 && (k == 0 || firstAssertion(b.code.substring(l.start(), l.end())) != null);
            if (hasArgs && !assertion) {
                break;
            }
            end = l.end();
            if (!assertion) {
                continue;
            }
            List<int[]> args = TestProfiles.pieces(b.code, l.open());
            if (args == null || args.isEmpty()) {
                b.expects.add(new Expect(actual + "." + l.name() + "(", l.name(), CHECKED, -1, -1));
                continue;
            }
            List<String> leading = new ArrayList<>();
            for (int[] a : args.subList(0, args.size() - 1)) {
                leading.add(b.raw(a[0], a[1]));
            }
            String label = l.name();
            if (!leading.isEmpty()) {
                String first = leading.getFirst();
                label = first.length() >= 2 && "'\"`".indexOf(first.charAt(0)) >= 0 && first.charAt(first.length() - 1) == first.charAt(0)
                        ? first.substring(1, first.length() - 1) : l.name() + "(" + String.join(", ", leading) + ")";
            }
            int[] value = args.getLast();
            b.expects.add(new Expect(actual + "." + l.name() + "(" + String.join(",", leading), label(label),
                    value(b, value), value[0], value[1]));
        }
        b.expectRanges.add(new int[]{s, end});
    }

    private Matcher firstAssertion(String code) {
        for (Pattern p : rules.assertions) {
            Matcher m = p.matcher(code);
            if (m.find()) {
                return m;
            }
        }
        return null;
    }

    /** The calls and properties chained from index from on (`.not.toBe(3)`), up to limit. */
    private static List<Link> chain(String code, int from, int limit) {
        List<Link> links = new ArrayList<>();
        int i = from;
        while (true) {
            int d = skipSpace(code, i, limit);
            if (d < limit && code.charAt(d) == '?' && d + 1 < limit && code.charAt(d + 1) == '.') {
                d++;
            }
            if (d >= limit || code.charAt(d) != '.') {
                return links;
            }
            int k = skipSpace(code, d + 1, limit);
            int e = k;
            while (e < limit && Character.isJavaIdentifierPart(code.charAt(e))) {
                e++;
            }
            if (e == k) {
                return links;
            }
            int p = skipSpace(code, e, limit);
            if (p < limit && code.charAt(p) == '(') {
                int close = matching(code, p, limit);
                if (close < 0) {
                    return links;
                }
                links.add(new Link(code.substring(k, e), d, close + 1, p, close));
                i = close + 1;
            } else {
                links.add(new Link(code.substring(k, e), d, e, -1, -1));
                i = e;
            }
        }
    }

    // ------------------------------------------------------------------ tokens

    /** Tokens of a body: code (strings blanked) decides the boundaries, vis (strings kept) gives the text. */
    static List<Tok> tokens(String vis, String code) {
        List<Tok> toks = new ArrayList<>();
        int n = code.length();
        int i = 0;
        while (i < n) {
            char c = code.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
                continue;
            }
            int end;
            boolean literal;
            if (c == '"' && code.startsWith("\"\"\"", i)) {
                int close = code.indexOf("\"\"\"", i + 3);
                end = close < 0 ? n : close + 3;
                literal = true;
            } else if (c == '"' || c == '\'') {
                int close = code.indexOf(c, i + 1);
                int eol = code.indexOf('\n', i);
                if (close < 0 || (eol >= 0 && close > eol)) {
                    close = (eol < 0 ? n : eol) - 1;
                }
                end = close + 1;
                literal = true;
            } else if (c == '`') {
                literal = true;
                int j = i + 1;
                while (j < n && code.charAt(j) != '`') {
                    if (code.startsWith("${", j)) {
                        literal = false;
                        int close = matching(code, j + 1, n);
                        j = close < 0 ? n : close + 1;
                    } else {
                        j++;
                    }
                }
                end = Math.min(n, j + 1);
            } else if (Character.isDigit(c) || (c == '.' && i + 1 < n && Character.isDigit(code.charAt(i + 1))
                    && (toks.isEmpty() || !isValue(toks.getLast())))) {
                Matcher m = NUMBER.matcher(code).region(i, n);
                end = m.lookingAt() ? m.end() : i + 1;
                literal = true;
                if (!toks.isEmpty() && toks.getLast().text().equals("-") && (toks.size() < 2 || !isValue(toks.get(toks.size() - 2)))) {
                    Tok minus = toks.removeLast();
                    toks.add(new Tok(collapse(vis.substring(minus.start(), end)).replace(" ", ""), minus.start(), end, true));
                    i = end;
                    continue;
                }
            } else if (Character.isJavaIdentifierStart(c)) {
                int j = i + 1;
                while (j < n && Character.isJavaIdentifierPart(code.charAt(j))) {
                    j++;
                }
                end = j;
                literal = LITERAL_WORDS.contains(code.substring(i, j));
            } else {
                end = i + 1;
                literal = false;
            }
            toks.add(new Tok(vis.substring(i, end), i, end, literal));
            i = end;
        }
        return toks;
    }

    /** A token after which "-" is a subtraction: a value, a name or a closing bracket. */
    private static boolean isValue(Tok t) {
        String s = t.text();
        return t.literal() || (t.ident() && !NOT_A_VALUE.contains(s)) || s.equals(")") || s.equals("]");
    }

    // ------------------------------------------------------------------ similar tests

    private CaseMatrix similar(String path, List<Case> cases) {
        Case first = cases.getFirst();
        List<List<Tok>> literals = cases.stream().map(c -> c.body().literals()).toList();
        int count = literals.getFirst().size();
        List<Integer> slots = new ArrayList<>();
        for (int k = 0; k < count; k++) {
            String v = literals.getFirst().get(k).text();
            for (List<Tok> l : literals) {
                if (!collapse(l.get(k).text()).equals(collapse(v))) {
                    slots.add(k);
                    break;
                }
            }
        }

        // expectations by key, the n-th repetition of a key in a test is a key of its own
        Map<String, String> labels = new LinkedHashMap<>();
        List<Map<String, Expect>> expects = new ArrayList<>();
        for (Case c : cases) {
            Map<String, Expect> byKey = new LinkedHashMap<>();
            Map<String, Integer> seen = new HashMap<>();
            for (Expect e : c.body().expects) {
                int n = seen.merge(e.key(), 1, Integer::sum);
                String key = n == 1 ? e.key() : e.key() + "#" + n;
                byKey.put(key, e);
                labels.putIfAbsent(key, n == 1 ? e.label() : e.label() + " (" + n + ")");
            }
            expects.add(byKey);
        }
        List<String> expectedKeys = new ArrayList<>();
        for (String key : labels.keySet()) {
            Expect e0 = expects.getFirst().get(key);
            boolean constant = e0 != null && expects.stream().allMatch(m -> m.get(key) != null && m.get(key).value().equals(e0.value()));
            if (!constant) {
                expectedKeys.add(key);
            }
        }

        List<Tok> skeleton = first.body().skeleton();
        List<Tok> firstLiterals = literals.getFirst();
        List<String> columnLabels = new ArrayList<>();
        List<String> roles = new ArrayList<>();
        for (int k : slots) {
            String label = inputLabel(skeleton, skeleton.indexOf(firstLiterals.get(k)));
            columnLabels.add(label == null ? "Wert " + (columnLabels.size() + 1) : label);
            roles.add(INPUT);
        }
        for (String key : expectedKeys) {
            columnLabels.add(labels.get(key));
            roles.add(EXPECTED);
        }
        unique(columnLabels);

        List<List<String>> values = new ArrayList<>();
        for (int r = 0; r < cases.size(); r++) {
            List<String> row = new ArrayList<>();
            for (int k : slots) {
                row.add(collapse(literals.get(r).get(k).text()));
            }
            for (String key : expectedKeys) {
                Expect e = expects.get(r).get(key);
                row.add(e == null ? null : e.value());
            }
            values.add(row);
        }
        List<CaseRow> rows = rows(values, slots.size(), cases.stream().map(c -> c.symbol().name()).toList(),
                cases.stream().map(Case::segment).toList(), cases.stream().map(Case::line).toList());

        // the template: the first test with its columns as slots
        Map<Integer, int[]> replace = new java.util.TreeMap<>();
        for (int i = 0; i < slots.size(); i++) {
            Tok t = firstLiterals.get(slots.get(i));
            replace.put(t.start(), new int[]{t.end(), i + 1});
        }
        for (int i = 0; i < expectedKeys.size(); i++) {
            Expect e = expects.getFirst().get(expectedKeys.get(i));
            if (e != null && e.start() >= 0) {
                replace.put(e.start(), new int[]{e.end(), slots.size() + i + 1});
            }
        }
        String title = title(first.symbol(), stem(columnLabels, slots.size(), cases));
        return new CaseMatrix(null, path, title, SIMILAR, template(first.body(), replace, 0),
                columns(columnLabels, roles, values), rows);
    }

    /**
     * The label of an input slot from its nearest context: `name =`, `name :=`, `key:`, else the call it is an
     * argument of (`putJerseyNumber(…) Arg 1`); null when there is none.
     */
    private static String inputLabel(List<Tok> sk, int p) {
        if (p < 0) {
            return null;
        }
        String prev = p > 0 ? sk.get(p - 1).text() : "";
        if (prev.equals("=") && p >= 2) {
            Tok before = sk.get(p - 2);
            if (before.ident()) {
                return before.text() + " =";
            }
            if (before.text().equals(":") && p >= 3 && sk.get(p - 3).ident()) {
                return sk.get(p - 3).text() + " :=";
            }
        }
        if (prev.equals(":") && p >= 2) {
            Tok key = sk.get(p - 2);
            if (key.ident() || (key.literal() && "'\"".indexOf(key.text().charAt(0)) >= 0)) {
                return unquote(key.text()) + ":";
            }
        }
        int depth = 0;
        int commas = 0;
        for (int i = p - 1; i >= 0; i--) {
            String t = sk.get(i).text();
            if (t.equals(")") || t.equals("]") || t.equals("}")) {
                depth++;
            } else if (t.equals("(") || t.equals("[") || t.equals("{")) {
                if (depth > 0) {
                    depth--;
                    continue;
                }
                if (t.equals("(") && i > 0 && sk.get(i - 1).ident() && !NO_CALL.contains(sk.get(i - 1).text())) {
                    return sk.get(i - 1).text() + "(…) Arg " + (commas + 1);
                }
                return null;
            } else if (t.equals(",") && depth == 0) {
                commas++;
            }
        }
        return null;
    }

    /** Shared part of a group's name: the call of the first input column, else the common leading words of the names. */
    private static String stem(List<String> labels, int inputs, List<Case> cases) {
        if (inputs > 0 && labels.getFirst().contains("(…)")) {
            return labels.getFirst().substring(0, labels.getFirst().indexOf("(…)") + 3);
        }
        List<String[]> words = cases.stream().map(c -> TestProfiles.words(c.symbol().name()).split(" ")).toList();
        int common = 0;
        outer:
        while (common < words.getFirst().length) {
            for (String[] w : words) {
                if (w.length <= common || !w[common].equals(words.getFirst()[common])) {
                    break outer;
                }
            }
            common++;
        }
        if (common > 0) {
            return String.join(" ", java.util.Arrays.copyOf(words.getFirst(), common)) + " …";
        }
        return cases.getFirst().symbol().name();
    }

    private static String title(Symbol test, String stem) {
        return test.container() == null ? stem : test.container() + " › " + stem;
    }

    // ------------------------------------------------------------------ parameterised tests

    private CaseMatrix parameterized(String path, Symbol test, String segment, Table table, Body body) {
        int width = 0;
        for (TableRow r : table.rows()) {
            width = Math.max(width, r.values().size());
        }
        List<String> labels = new ArrayList<>();
        for (int i = 0; i < width; i++) {
            String l = i < table.labels().size() ? table.labels().get(i) : "";
            labels.add(l == null || l.isBlank() ? "Arg " + (i + 1) : l);
        }
        int nameColumn = -1;
        if (TestProfiles.GO.equals(table.style())) {
            for (int i = 0; i < width && nameColumn < 0; i++) {
                String l = labels.get(i);
                if (rules.caseMatrix.nameFields().stream().anyMatch(p -> p.matcher(l).find())) {
                    nameColumn = i;
                }
            }
        }
        // template from the first line after a table in the body (Go)
        int from = 0;
        if (table.endLine() > 0) {
            int index = table.endLine() - body.firstLine + 1;
            from = index > 0 && index < body.lineStarts.length ? body.lineStart(index) : 0;
        }
        List<Integer> inputs = new ArrayList<>();
        List<Integer> expected = new ArrayList<>();
        Map<Integer, List<int[]>> usages = new HashMap<>();
        for (int i = 0; i < width; i++) {
            if (i == nameColumn) {
                continue;
            }
            String label = labels.get(i);
            List<int[]> uses = usages(body, label, table.rowVar(), from);
            usages.put(i, uses);
            boolean byName = rules.caseMatrix.expectedNames().stream().anyMatch(p -> p.matcher(label).find());
            long inExpectation = uses.stream().filter(u -> body.inExpectation(u[2])).count();
            boolean onlyExpected = inExpectation > 0 && inExpectation == uses.size();
            (byName || onlyExpected ? expected : inputs).add(i);
        }
        List<Integer> order = new ArrayList<>(inputs);
        order.addAll(expected);
        List<String> columnLabels = new ArrayList<>();
        List<String> roles = new ArrayList<>();
        for (int i : order) {
            columnLabels.add(labels.get(i));
            roles.add(inputs.contains(i) ? INPUT : EXPECTED);
        }
        List<List<String>> values = new ArrayList<>();
        List<String> names = new ArrayList<>();
        List<Integer> lines = new ArrayList<>();
        for (int r = 0; r < table.rows().size(); r++) {
            TableRow row = table.rows().get(r);
            List<String> v = new ArrayList<>();
            for (int i : order) {
                v.add(i < row.values().size() ? row.values().get(i) : null);
            }
            values.add(v);
            names.add(rowName(table, row, r, labels, nameColumn));
            lines.add(row.line());
        }
        List<CaseRow> rows = rows(values, inputs.size(), names, java.util.Collections.nCopies(names.size(), segment), lines);
        Map<Integer, int[]> replace = new java.util.TreeMap<>();
        for (int c = 0; c < order.size(); c++) {
            for (int[] u : usages.getOrDefault(order.get(c), List.of())) {
                replace.put(u[0], new int[]{u[1], c + 1});
            }
        }
        return new CaseMatrix(null, path, title(test, test.name()), PARAMETERIZED, template(body, replace, from),
                columns(columnLabels, roles, values), rows);
    }

    /**
     * Where a column is used in the body (from offset from on): the name itself (not after "." and not as an object
     * key), or `rowVar.name` when the row is reached through a variable. [start, end, offset of the name].
     */
    private static List<int[]> usages(Body body, String name, String rowVar, int from) {
        List<int[]> result = new ArrayList<>();
        List<Tok> toks = body.toks;
        for (int i = 0; i < toks.size(); i++) {
            Tok t = toks.get(i);
            if (t.start() < from || !t.ident() || !t.text().equals(name)) {
                continue;
            }
            String prev = i > 0 ? toks.get(i - 1).text() : "";
            String next = i + 1 < toks.size() ? toks.get(i + 1).text() : "";
            if (rowVar != null) {
                if (prev.equals(".") && i >= 2 && toks.get(i - 2).text().equals(rowVar)) {
                    result.add(new int[]{toks.get(i - 2).start(), t.end(), t.start()});
                }
            } else if (!prev.equals(".") && !(next.equals(":") && (prev.equals("{") || prev.equals(",")))) {
                result.add(new int[]{t.start(), t.end(), t.start()});
            }
        }
        return result;
    }

    /** The name of a parameterised case: its display name when the test declares one, else "[n] values". */
    private static String rowName(Table table, TableRow row, int index, List<String> labels, int nameColumn) {
        List<String> v = row.values();
        String template = table.nameTemplate();
        switch (table.style()) {
            case TestProfiles.GO -> {
                if (nameColumn >= 0 && nameColumn < v.size() && v.get(nameColumn) != null) {
                    return unquote(v.get(nameColumn));
                }
                return row.key() != null ? unquote(row.key()) : "[" + (index + 1) + "]";
            }
            case TestProfiles.JUNIT -> {
                List<String> plain = v.stream().map(x -> x == null ? "null" : unquote(x)).toList();
                if (template == null || template.isBlank()) {
                    return "[" + (index + 1) + "] " + String.join(", ", plain);
                }
                String s = template.replace("{index}", String.valueOf(index + 1))
                        .replace("{arguments}", String.join(", ", plain))
                        .replace("{argumentsWithNames}", String.join(", ", plain));
                for (int i = 0; i < plain.size(); i++) {
                    s = s.replace("{" + i + "}", plain.get(i));
                }
                return s;
            }
            default -> {
                if (template == null || template.isBlank()) {
                    return "[" + (index + 1) + "]";
                }
                StringBuilder sb = new StringBuilder();
                int next = 0;
                for (int i = 0; i < template.length(); i++) {
                    char c = template.charAt(i);
                    if (c == '%' && i + 1 < template.length()) {
                        char f = template.charAt(i + 1);
                        if ("sdifjop".indexOf(f) >= 0) {
                            sb.append(next < v.size() && v.get(next) != null ? unquote(v.get(next)) : "");
                            next++;
                            i++;
                            continue;
                        }
                        if (f == '#') {
                            sb.append(index);
                            i++;
                            continue;
                        }
                        if (f == '%') {
                            sb.append('%');
                            i++;
                            continue;
                        }
                    }
                    sb.append(c);
                }
                Matcher m = DOLLAR_NAME.matcher(sb.toString());
                StringBuilder out = new StringBuilder();
                while (m.find()) {
                    int k = labels.indexOf(m.group(1));
                    String value = k >= 0 && k < v.size() && v.get(k) != null ? unquote(v.get(k)) : m.group();
                    m.appendReplacement(out, Matcher.quoteReplacement(value));
                }
                m.appendTail(out);
                return out.toString();
            }
        }
    }

    // ------------------------------------------------------------------ shared

    /**
     * Rows with their findings: duplicateOf = the first earlier row with the same input values (the first inputs
     * columns), contradicts = such a duplicate expects another value in a column both rows check.
     */
    private static List<CaseRow> rows(List<List<String>> values, int inputs, List<String> names, List<String> segments,
                                      List<Integer> lines) {
        List<CaseRow> rows = new ArrayList<>();
        for (int r = 0; r < values.size(); r++) {
            List<String> v = values.get(r);
            Integer duplicateOf = null;
            boolean contradicts = false;
            for (int q = 0; q < r; q++) {
                if (v.subList(0, inputs).equals(values.get(q).subList(0, inputs))) {
                    duplicateOf = q;
                    for (int c = inputs; c < v.size(); c++) {
                        String a = v.get(c);
                        String b = values.get(q).get(c);
                        if (a != null && b != null && !a.equals(b)) {
                            contradicts = true;
                        }
                    }
                    break;
                }
            }
            rows.add(new CaseRow(names.get(r), segments.get(r), lines.get(r), java.util.Collections.unmodifiableList(new ArrayList<>(v)),
                    duplicateOf, contradicts));
        }
        return rows;
    }

    /**
     * Columns with the covered values of the input columns: distinct, sorted - numerically when all are numbers.
     * (A later hint about missing boundary values would attach here, next to the covered values.)
     */
    private static List<CaseColumn> columns(List<String> labels, List<String> roles, List<List<String>> values) {
        List<CaseColumn> columns = new ArrayList<>();
        for (int c = 0; c < labels.size(); c++) {
            int column = c;
            List<String> covered = List.of();
            if (INPUT.equals(roles.get(c))) {
                List<String> distinct = new ArrayList<>(new java.util.LinkedHashSet<>(
                        values.stream().map(r -> r.get(column)).filter(Objects::nonNull).toList()));
                covered = sorted(distinct);
            }
            columns.add(new CaseColumn(labels.get(c), roles.get(c), covered));
        }
        return columns;
    }

    static List<String> sorted(List<String> values) {
        boolean numeric = !values.isEmpty() && values.stream().allMatch(v -> NUMERIC.matcher(v).matches());
        List<String> result = new ArrayList<>(values);
        if (numeric) {
            result.sort(Comparator.comparing(CaseMatrices::number));
        } else {
            result.sort(Comparator.naturalOrder());
        }
        return result;
    }

    private static BigDecimal number(String v) {
        return new BigDecimal(v.replace("_", "").replaceAll("[lLfFdD]$", ""));
    }

    /** Same labels get " (2)", " (3)", … */
    private static void unique(List<String> labels) {
        Set<String> seen = new TreeSet<>();
        for (int i = 0; i < labels.size(); i++) {
            String l = labels.get(i);
            int n = 2;
            while (!seen.add(labels.get(i))) {
                labels.set(i, l + " (" + n++ + ")");
            }
        }
    }

    /**
     * The body from offset from on with the ranges replaced by slots ‹n› (start -> [end, n]), without the braces of
     * the body, dedented, at most MAX_TEMPLATE_LINES lines.
     */
    private static String template(Body b, Map<Integer, int[]> replace, int from) {
        int start = from;
        int s = skipSpace(b.code, start, b.code.length());
        if (s < b.code.length() && b.code.charAt(s) == '{') {
            start = s + 1;
        }
        int end = b.code.lastIndexOf('}');
        if (end < start) {
            end = b.code.length();
        }
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < end; i++) {
            int[] r = replace.get(i);
            if (r != null && r[0] <= end) {
                sb.append('‹').append(r[1]).append('›');
                i = r[0] - 1;
                continue;
            }
            sb.append(b.vis.charAt(i));
        }
        List<String> lines = new ArrayList<>(List.of(sb.toString().split("\n", -1)));
        lines.replaceAll(String::stripTrailing);
        while (!lines.isEmpty() && lines.getFirst().isBlank()) {
            lines.removeFirst();
        }
        while (!lines.isEmpty() && lines.getLast().isBlank()) {
            lines.removeLast();
        }
        int indent = Integer.MAX_VALUE;
        for (String l : lines) {
            if (!l.isBlank()) {
                indent = Math.min(indent, CodeText.indent(l));
            }
        }
        List<String> out = new ArrayList<>();
        for (String l : lines) {
            out.add(l.isBlank() ? "" : l.substring(Math.min(indent, l.length())));
            if (out.size() == MAX_TEMPLATE_LINES) {
                out.add("…");
                break;
            }
        }
        return String.join("\n", out);
    }

    private static String value(Body b, int[] range) {
        String v = b.raw(range[0], range[1]);
        return v.length() > MAX_VALUE ? v.substring(0, MAX_VALUE - 1) + "…" : v;
    }

    private static String label(String text) {
        String t = collapse(text);
        return t.length() > MAX_LABEL ? t.substring(0, MAX_LABEL - 1) + "…" : t;
    }

    private static String collapse(String s) {
        return s.replaceAll("\\s+", " ").strip();
    }

    private static String unquote(String v) {
        String s = v.strip();
        if (s.length() >= 2 && "'\"`".indexOf(s.charAt(0)) >= 0 && s.charAt(s.length() - 1) == s.charAt(0)) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    /** [from, to) without surrounding whitespace and trailing ";" / ","; null when nothing is left. */
    private static int[] trimmed(String code, int from, int to) {
        int a = from;
        int z = to;
        while (a < z && Character.isWhitespace(code.charAt(a))) {
            a++;
        }
        while (z > a && (Character.isWhitespace(code.charAt(z - 1)) || code.charAt(z - 1) == ';' || code.charAt(z - 1) == ',')) {
            z--;
        }
        return a < z ? new int[]{a, z} : null;
    }

    private static int skipSpace(String s, int i, int limit) {
        while (i < limit && Character.isWhitespace(s.charAt(i))) {
            i++;
        }
        return i;
    }

    /** Index of the bracket closing the one at open, searching before limit; -1 if none. */
    private static int matching(String code, int open, int limit) {
        int depth = 0;
        for (int i = open; i < limit && i < code.length(); i++) {
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
