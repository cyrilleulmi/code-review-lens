package dev.smartcodereview.analysis;

import dev.smartcodereview.analysis.SymbolExtractor.Symbol;
import dev.smartcodereview.model.Model.ExpectationChange;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Changed expectations in tests: what an existing test checks, old against new version. Deterministic and
 * pattern-based (rules "assertions", "weakAssertions", "disabledTests"), no AI:
 * <ol>
 *   <li><b>Assertion statements:</b> a line of the test body whose code (strings and comments blanked) contains an
 *       "assertions" pattern starts one. It extends over the following lines while brackets are open, and over
 *       continuation lines starting with "." that are no assertion themselves (multi-line expect(…)\n.toBe(…),
 *       AssertJ chains). Of the declaration line only the part after the first "{" or "=>" counts (a test named
 *       verifySaved is no assertion). Its text is compared without whitespace and without trailing ";" or "," before
 *       a closing bracket, so reformatting is no change.</li>
 *   <li><b>Subject</b> (what is checked), from the call the pattern matched: for a chained matcher (pattern match
 *       starts with ".", e.g. RestAssured .statusCode(…), .body("path", …), MockMvc .andExpect(…)) the text before
 *       it, the call and all its arguments but the last; for the equality family (assertEquals, assertNotEquals,
 *       assertSame, assertArrayEquals, …, testify Equal/EqualValues/…) the actual value: the second argument, the
 *       third when the first is a string literal (JUnit 4 message first); otherwise the call and its first argument
 *       (expect(x), assertThat(x), verify(repo), assertNull(x)). A leading Go test handle (t, b, s.T()) is dropped.
 *       Infix matchers without parentheses (Kotest "x shouldBe 3"): the text before the matcher.</li>
 *   <li><b>Pairing:</b> identical statements first (in order), then the remaining ones with the same subject (in
 *       order) = "changed"; "weakened" when the new one matches a "weakAssertions" pattern and the old one did not.
 *       Unpaired old ones are "removed" ("weakened" when the test still has assertions but only weak ones), unpaired
 *       new ones "added".</li>
 *   <li><b>Disabled:</b> a "disabledTests" pattern in the head of a test or suite (annotation lines and the
 *       declaration line) or, for tests, in a top-level statement of its body (indented like the first body line,
 *       e.g. Go t.Skip(…) but not a t.Skip inside an if). A test inside a disabled suite is disabled too.</li>
 * </ol>
 * Limits: only statements directly in the test body count (not helpers or beforeEach); expected values kept in
 * variables (want := 3) change outside the assertion and are not seen.
 */
public final class Expectations {

    public static final String CHANGED = "changed";
    public static final String WEAKENED = "weakened";
    public static final String REMOVED = "removed";
    public static final String ADDED = "added";
    public static final String DISABLED = "disabled";
    public static final String ENABLED = "enabled";

    /** Longest text of an assertion shown in the UI. */
    private static final int MAX_TEXT = 240;
    /** The equality family: expected first, actual second (JUnit, Kotlin, Go testify). */
    private static final Pattern EQUALITY = Pattern.compile(
            "(?i)(assert)?(not)?(equals?|same|arrayequals|iterableequals|linesmatch|equalvalues|exactly|jsoneq|yamleq|elementsmatch|indelta|inepsilon)");
    /** Go test handle as first argument (testing.T / B / F, testify suites). */
    private static final Pattern GO_HANDLE = Pattern.compile("t|b|f|s\\.T\\(\\)|suite\\.T\\(\\)");
    private static final Pattern TRAILING_COMMA = Pattern.compile(",([)\\]}])");

    private final List<Pattern> assertions;
    private final List<Pattern> weak;
    private final List<Pattern> disabled;

    public Expectations(Rules rules) {
        this.assertions = rules.assertions;
        this.weak = rules.weakAssertions;
        this.disabled = rules.disabledTests;
    }

    /**
     * One assertion statement. line / endLine: first and last line (1-based); text: shown (trimmed lines joined);
     * norm: compared (without whitespace); subject: key for pairing; weak: only checks existence / truthiness;
     * code: the statement with string contents and comments blanked (lines joined, untruncated).
     */
    public record Assertion(int line, String text, String norm, String subject, boolean weak, int endLine, String code) {
    }

    /**
     * Assertion statements of a test, in order: from its declaration line (only the part after the first "{" or
     * "=>", so a test named verifyX or shouldBeX is no assertion) to its end. Annotation lines are skipped.
     */
    public List<Assertion> assertions(CodeText text, Symbol s) {
        int decl = declarationLine(text, s);
        int last = Math.min(s.endLine(), text.lines.size());
        if (decl > last) {
            return List.of();
        }
        String[] raw = new String[last - decl + 1];
        String[] code = new String[raw.length];
        for (int i = 0; i < raw.length; i++) {
            raw[i] = text.lines.get(decl - 1 + i);
            code[i] = text.code.get(decl - 1 + i);
        }
        int brace = code[0].indexOf('{');
        int arrow = code[0].indexOf("=>");
        int col = brace < 0 && arrow < 0 ? code[0].length()
                : brace < 0 ? arrow + 2 : arrow < 0 ? brace + 1 : Math.min(brace + 1, arrow + 2);
        raw[0] = " ".repeat(Math.min(col, raw[0].length())) + raw[0].substring(Math.min(col, raw[0].length()));
        code[0] = " ".repeat(col) + code[0].substring(col);
        return assertions(raw, code, decl);
    }

    /** Assertion statements in the given lines (raw and code-only, aligned); firstLine: number of the first line. */
    private List<Assertion> assertions(String[] raw, String[] code, int firstLine) {
        List<Assertion> result = new ArrayList<>();
        for (int i = 0; i < code.length; i++) {
            if (find(assertions, code[i]) == null) {
                continue;
            }
            int end = closeBrackets(code, i);
            while (end + 1 < code.length) {
                String next = code[end + 1];
                if (!next.strip().startsWith(".") || find(assertions, next) != null) {
                    break;
                }
                end = closeBrackets(code, end + 1);
            }
            result.add(assertion(raw, code, i, end, firstLine));
            i = end;
        }
        return result;
    }

    /**
     * The first line (1-based) of a symbol that is not blank, a comment or an annotation (also not a continuation
     * line of an annotation whose arguments span lines): its declaration.
     */
    static int declarationLine(CodeText text, Symbol s) {
        int last = Math.min(s.endLine(), text.lines.size());
        for (int li = s.startLine(); li <= last; li++) {
            String t = text.code.get(li - 1).strip();
            if (t.startsWith("@")) {
                li = SymbolExtractor.annotationEnd(text, li - 1) + 1;
            } else if (!t.isEmpty()) {
                return li;
            }
        }
        return s.startLine();
    }

    /** The last line of a statement starting at line i: following lines while ( [ { are open. */
    private static int closeBrackets(String[] code, int i) {
        int depth = depth(code[i]);
        int end = i;
        while (depth > 0 && end + 1 < code.length) {
            end++;
            depth += depth(code[end]);
        }
        return end;
    }

    private static int depth(String code) {
        int d = 0;
        for (int i = 0; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                d++;
            } else if (c == ')' || c == ']' || c == '}') {
                d--;
            }
        }
        return d;
    }

    private Assertion assertion(String[] rawLines, String[] codeLines, int from, int to, int firstLine) {
        StringBuilder raw = new StringBuilder();
        StringBuilder code = new StringBuilder();
        for (int i = from; i <= to; i++) {
            String c = codeLines[i];
            String r = rawLines[i];
            int start = CodeText.indent(c);
            int end = c.stripTrailing().length();
            if (end <= start) {
                continue; // blank or comment only
            }
            if (!raw.isEmpty()) {
                raw.append(' ');
                code.append(' ');
            }
            raw.append(r, Math.min(start, r.length()), Math.min(end, r.length()));
            code.append(c, start, end);
        }
        String r = raw.toString();
        String c = code.toString();
        String shown = r.length() > MAX_TEXT ? r.substring(0, MAX_TEXT - 1) + "…" : r;
        return new Assertion(firstLine + from, shown, norm(r), subject(r, c), find(weak, c) != null, firstLine + to, c);
    }

    /** Without whitespace, without trailing ";" and without a trailing "," before a closing bracket. */
    static String norm(String s) {
        String n = s.replaceAll("\\s+", "");
        n = TRAILING_COMMA.matcher(n).replaceAll("$1");
        while (n.endsWith(";")) {
            n = n.substring(0, n.length() - 1);
        }
        return n;
    }

    /** What the assertion checks (see the class comment); raw and code are aligned (same length). */
    private String subject(String raw, String code) {
        Matcher m = find(assertions, code);
        if (m == null) {
            return norm(raw);
        }
        int start = m.start();
        while (start < code.length() && Character.isWhitespace(code.charAt(start))) {
            start++;
        }
        boolean chained = start < code.length() && code.charAt(start) == '.';
        int i = chained ? start + 1 : start;
        while (i < code.length() && (Character.isJavaIdentifierPart(code.charAt(i)) || code.charAt(i) == '.')) {
            i++;
        }
        String callee = raw.substring(start, i);
        String prefix = norm(raw.substring(0, start));
        int j = skipSpaces(code, i);
        if (j < code.length() && code.charAt(j) == '<') {
            int close = code.indexOf('>', j);
            j = close < 0 ? j : skipSpaces(code, close + 1);
        }
        if (j >= code.length() || code.charAt(j) != '(') {
            // infix matcher (Kotest: x shouldBe 3) or a bare keyword: what stands before it
            return prefix.isEmpty() ? norm(raw) : "infix:" + prefix;
        }
        List<String> args = arguments(raw, code, j);
        boolean goHandle = !args.isEmpty() && GO_HANDLE.matcher(args.getFirst()).matches();
        if (goHandle) {
            args = args.subList(1, args.size());
        }
        if (chained) {
            return prefix + callee + "(" + String.join(",", args.subList(0, Math.max(0, args.size() - 1)));
        }
        // JS assert.equal(actual, expected) has the other order: only assertXxx, unqualified calls and testify
        String name = callee.substring(callee.lastIndexOf('.') + 1);
        boolean equality = EQUALITY.matcher(name).matches()
                && (name.startsWith("assert") || !callee.contains(".") || goHandle);
        if (equality && args.size() >= 2) {
            boolean messageFirst = args.size() >= 3 && (args.getFirst().startsWith("\"") || args.getFirst().startsWith("'"));
            return "=" + args.get(messageFirst ? 2 : 1);
        }
        return callee + "(" + (args.isEmpty() ? "" : args.getFirst());
    }

    private static int skipSpaces(String s, int i) {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
            i++;
        }
        return i;
    }

    /** Top-level arguments (normalised) of the call whose "(" is at open; strings are already blanked in code. */
    private static List<String> arguments(String raw, String code, int open) {
        List<String> args = new ArrayList<>();
        int depth = 0;
        int argStart = open + 1;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
                if (depth == 0) {
                    addArgument(args, raw.substring(argStart, i));
                    return args;
                }
            } else if (c == ',' && depth == 1) {
                addArgument(args, raw.substring(argStart, i));
                argStart = i + 1;
            }
        }
        addArgument(args, raw.substring(Math.min(argStart, raw.length())));
        return args;
    }

    private static void addArgument(List<String> args, String arg) {
        String n = norm(arg);
        if (!n.isEmpty()) {
            args.add(n);
        }
    }

    /**
     * The line (1-based) that switches a test or suite off, or 0: a "disabledTests" pattern in its head (leading
     * comment/annotation lines plus the declaration line) or, for a test, in a top-level line of its body.
     */
    public int disabledLine(CodeText text, Symbol s, boolean test) {
        int last = Math.min(s.endLine(), text.lines.size());
        int li = s.startLine();
        for (; li <= last; li++) {
            String c = text.code.get(li - 1);
            if (find(disabled, c) != null) {
                return li;
            }
            String t = c.strip();
            if (t.startsWith("@")) {
                li = Math.max(li, SymbolExtractor.annotationEnd(text, li - 1) + 1); // skip the arguments of a multi-line annotation
            } else if (!t.isEmpty()) {
                break; // the declaration line
            }
        }
        if (!test) {
            return 0;
        }
        int indent = -1;
        for (li = li + 1; li < last; li++) {
            String c = text.code.get(li - 1);
            if (c.isBlank()) {
                continue;
            }
            int in = CodeText.indent(c);
            if (indent < 0) {
                indent = in;
            }
            if (in <= indent && find(disabled, c) != null) {
                return li;
            }
        }
        return 0;
    }

    /**
     * The expectation changes from the old assertions of a test to its new ones: identical statements pair first,
     * then statements with the same subject. Sorted by their place in the new test (removed ones after the
     * statement they followed).
     */
    public List<ExpectationChange> compare(List<Assertion> olds, List<Assertion> news) {
        Assertion[] partner = new Assertion[olds.size()];
        boolean[] used = new boolean[news.size()];
        for (int i = 0; i < olds.size(); i++) {
            for (int j = 0; j < news.size(); j++) {
                if (!used[j] && olds.get(i).norm().equals(news.get(j).norm())) {
                    partner[i] = news.get(j);
                    used[j] = true;
                    break;
                }
            }
        }
        boolean[] changed = new boolean[olds.size()];
        for (int i = 0; i < olds.size(); i++) {
            if (partner[i] != null) {
                continue;
            }
            for (int j = 0; j < news.size(); j++) {
                if (!used[j] && olds.get(i).subject().equals(news.get(j).subject())) {
                    partner[i] = news.get(j);
                    used[j] = true;
                    changed[i] = true;
                    break;
                }
            }
        }
        boolean onlyWeakLeft = !news.isEmpty() && news.stream().allMatch(Assertion::weak);

        record Placed(double at, ExpectationChange change) {
        }
        List<Placed> placed = new ArrayList<>();
        int anchor = 0;
        for (int i = 0; i < olds.size(); i++) {
            Assertion o = olds.get(i);
            Assertion n = partner[i];
            if (n != null) {
                anchor = n.line();
                if (changed[i]) {
                    String kind = n.weak() && !o.weak() ? WEAKENED : CHANGED;
                    placed.add(new Placed(n.line(), new ExpectationChange(kind, o.text(), n.text(), o.line(), n.line())));
                }
            } else {
                String kind = onlyWeakLeft && !o.weak() ? WEAKENED : REMOVED;
                placed.add(new Placed(anchor + 0.5, new ExpectationChange(kind, o.text(), null, o.line(), null)));
            }
        }
        for (int j = 0; j < news.size(); j++) {
            if (!used[j]) {
                Assertion n = news.get(j);
                placed.add(new Placed(n.line(), new ExpectationChange(ADDED, null, n.text(), null, n.line())));
            }
        }
        placed.sort(Comparator.comparingDouble(Placed::at)); // stable: old order among equals
        return placed.stream().map(Placed::change).toList();
    }

    /** The trimmed text of a line (1-based). */
    static String lineText(CodeText text, int line) {
        String t = text.lines.get(line - 1).strip();
        return t.length() > MAX_TEXT ? t.substring(0, MAX_TEXT - 1) + "…" : t;
    }

    private static Matcher find(List<Pattern> patterns, String code) {
        for (Pattern p : patterns) {
            Matcher m = p.matcher(code);
            if (m.find()) {
                return m;
            }
        }
        return null;
    }
}
