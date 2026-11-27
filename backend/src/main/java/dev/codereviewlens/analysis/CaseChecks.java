package dev.codereviewlens.analysis;

import dev.codereviewlens.analysis.SymbolExtractor.Symbol;
import dev.codereviewlens.analysis.TestProfiles.Table;
import dev.codereviewlens.analysis.TestProfiles.TableRow;
import dev.codereviewlens.analysis.TestProfiles.TestText;
import dev.codereviewlens.model.Model.CaseFinding;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fall- und Effekt-Abgleich: what the code of a changed function can do compared with what the tests that really reach
 * it check. Coverage only says whether a test reaches a function; this looks at its cases and effects. Deterministic
 * and pattern-based (rules section "caseCheck", see {@link Rules.CaseCheckRules}), no AI:
 * <ol>
 *   <li><b>Error outcomes</b> (whole function, code with strings and comments blanked): "caseCheck.exceptions" -
 *       throw new X(…), Kotlin throw X(…), throwError(…), Promise.reject(…), errors.New(…). Checked when a reaching test
 *       expects the type ("typedChecks": assertThrows(X.class, isInstanceOf(X.class), toThrow(X) …), expects some error
 *       ("anyChecks": toThrow(), assert.Error …) or the HTTP status the exception maps to ("statuses", else an integer
 *       400-599 or a status constant in its arguments; "statusChecks": .statusCode(404), { status: 404 } …), searched
 *       in the test's head and body.</li>
 *   <li><b>Boundaries</b> (whole function): comparisons {@code <, <=, >, >=} of a value (a name or a member chain, not
 *       .length/.size()/.count, not in a for header) with an integer literal or a same-file integer constant
 *       ({@code MAX = 99}). Boundary values: {@code x < k}, {@code x >= k} → k-1 and k; {@code x > k}, {@code x <= k}
 *       → k and k+1. Grouped per compared value. Checked values: the integers among the inputs of the reaching tests
 *       (the full argument lists of their calls to the code under test and of HTTP requests, parameter sources, the
 *       input columns of their Fallmatrix rows; a string holding only an integer counts as that integer).</li>
 *   <li><b>Branches vs. tests</b>: more decision points ({@link Coverage#branches}) than distinct reaching tests -
 *       information, not a warning (only when at least one test reaches the function).</li>
 *   <li><b>Effects</b> (changed lines only): "caseCheck.effects" - field assignments and setters (field), persistence
 *       calls (persist), messages/events (message), plus outgoing HTTP calls with a literal URL ({@link Http#calls}).
 *       Checked when an assertion of a reaching test mentions the field ("fieldChecks", case-insensitive word),
 *       verifies the call ("callChecks"), reads stored data again for persist effects ("readBack") or asserts the HTTP
 *       call ("httpChecks").</li>
 * </ol>
 * Limits: only static evidence - an exception subclass checked via its superclass, a value reaching the code through a
 * variable or helper of another file, effects checked through rendered output (DOM) are not seen; only integers.
 */
public final class CaseChecks {

    public static final String EXCEPTION = "exception";
    public static final String BOUNDARY = "boundary";
    public static final String EFFECT = "effect";
    public static final String BRANCHES = "branches";

    /** A comparison of a value with a number or a constant: value op bound, or bound op value. */
    private static final String OPERAND = "[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*(?:\\(\\s*\\))?)*|-?\\d[\\d_]*[lL]?";
    /** Not part of a sum or product on either side (`a - 1 < b`, `x < MAX - 1` are no plain boundaries). */
    private static final Pattern COMPARISON = Pattern.compile(
            "(?<![\\w$.])(?<![-+*/%]\\s)(?<![-+*/%])(?<left>" + OPERAND + ")\\s*(?<op><=|>=|<|>)\\s*(?<right>" + OPERAND + ")"
                    + "(?![\\w$.(])(?!\\s*[-+*/%](?![-+=]))");
    private static final Pattern INTEGER = Pattern.compile("-?\\d[\\d_]*[lL]?");
    private static final Pattern FOR_HEADER = Pattern.compile("\\bfor\\s*\\(");
    /** Sizes of collections and strings: their boundaries are about the elements, not about a number the test passes. */
    private static final Pattern SIZE = Pattern.compile("(?i)(?:^|\\.)(?:length|size|count|len)(?:\\(\\s*\\))?$");
    private static final Pattern STATUS_CODE = Pattern.compile("(?<![\\w.])([1-5]\\d\\d)(?![\\w.])");
    private static final Pattern STATUS_CONSTANT = Pattern.compile("\\b(?:HttpStatus(?:Code)?|Status)\\.([A-Z_]+)\\b|\\bhttp\\.Status(\\w+)\\b");

    /**
     * What one test shows. id: segment id of a changed test, "e1" … of an existing one. text: its head and body
     * (comments blanked, strings kept); assertions: its assertion statements (same text, lines joined); numbers: the
     * integers among its inputs (mutable: the Fallmatrix adds the input values of its rows).
     */
    public record Evidence(String id, String text, List<String> assertions, Set<Long> numbers) {
    }

    /**
     * A boundary found in a function. subject: the compared value; label: "1…99", "≥ 1", "≤ 99"; values: its boundary
     * values, sorted; line: of the first comparison.
     */
    public record Boundary(String subject, String label, List<Long> values, int line) {
    }

    /** The findings of a function and its boundaries (for the Fallmatrix). */
    public record Result(List<CaseFinding> findings, List<Boundary> boundaries) {
    }

    private final Rules.CaseCheckRules rules;
    private final List<Pattern> expectedNames;
    private final TestProfiles profiles;
    private final Map<String, Pattern> compiled = new LinkedHashMap<>();

    public CaseChecks(Rules rules) {
        this.rules = rules.caseCheck;
        this.expectedNames = rules.caseMatrix.expectedNames();
        this.profiles = new TestProfiles(rules);
    }

    // ------------------------------------------------------------------ the tests

    /** The evidence of one test case (see {@link Evidence}); targets: the names of the code it calls directly. */
    public Evidence evidence(String id, CodeText text, List<Symbol> symbols, Symbol test, List<String> targets) {
        TestText t = profiles.read(text, symbols, test, targets);
        Set<Long> numbers = new TreeSet<>(numbers(profiles.fullInputs(t, targets)));
        Table table = profiles.table(text, test);
        if (table != null) {
            for (int c = 0; c < table.labels().size(); c++) {
                String label = table.labels().get(c);
                if (label != null && expectedNames.stream().anyMatch(p -> p.matcher(label).find())) {
                    continue; // an expected value, not an input
                }
                for (TableRow r : table.rows()) {
                    if (c < r.values().size()) {
                        Long n = number(r.values().get(c));
                        if (n != null) {
                            numbers.add(n);
                        }
                    }
                }
            }
        }
        int decl = Expectations.declarationLine(text, test);
        List<String> assertions = new ArrayList<>();
        for (Expectations.Assertion a : t.assertions()) {
            StringBuilder sb = new StringBuilder();
            for (int li = a.line(); li <= Math.min(a.endLine(), text.visible.size()); li++) {
                String vis = text.visible.get(li - 1);
                if (li == decl) { // only the part after the first "{" or "=>" (the test name is no assertion)
                    String code = text.code.get(li - 1);
                    int brace = code.indexOf('{');
                    int arrow = code.indexOf("=>");
                    int col = brace < 0 && arrow < 0 ? 0 : brace < 0 ? arrow + 2 : arrow < 0 ? brace + 1 : Math.min(brace + 1, arrow + 2);
                    vis = vis.substring(Math.min(col, vis.length()));
                }
                sb.append(vis.strip()).append(' ');
            }
            assertions.add(sb.toString().strip());
        }
        return new Evidence(id, t.head() + "\n" + t.body(), assertions, numbers);
    }

    /** Adds input values written as in the code (a Fallmatrix cell: 7, -3, '150', "23") to a test's numbers. */
    public static void addValue(Evidence e, String value) {
        Long n = number(value);
        if (n != null) {
            e.numbers().add(n);
        }
    }

    /** Adds the integers in a piece of test code (see {@link #numbers}, e.g. the request of a helper) to a test's numbers. */
    public static void addNumbers(Evidence e, String text) {
        if (text != null && !text.isBlank()) {
            e.numbers().addAll(numbers(text));
        }
    }

    /** An integer as written in the code, also inside quotes ('150', "-3"); null for anything else. */
    static Long number(String value) {
        if (value == null) {
            return null;
        }
        String v = value.strip();
        if (v.length() >= 2 && (v.charAt(0) == '"' || v.charAt(0) == '\'' || v.charAt(0) == '`') && v.charAt(v.length() - 1) == v.charAt(0)) {
            v = v.substring(1, v.length() - 1).strip();
        }
        if (!INTEGER.matcher(v).matches()) {
            return null;
        }
        v = v.replace("_", "");
        if (v.endsWith("l") || v.endsWith("L")) {
            v = v.substring(0, v.length() - 1);
        }
        try {
            return Long.parseLong(v);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * The integers in a piece of test code: number literals (with a minus when no value stands before it) and strings
     * that hold only an integer; numbers inside other strings or names do not count.
     */
    static List<Long> numbers(String text) {
        List<Long> result = new ArrayList<>();
        int n = text.length();
        int i = 0;
        char previous = '(';
        while (i < n) {
            char c = text.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
                continue;
            }
            if (c == '"' || c == '\'' || c == '`') {
                int close = text.indexOf(c, i + 1);
                int eol = text.indexOf('\n', i);
                if (close < 0 || (eol >= 0 && close > eol)) {
                    close = eol < 0 ? n - 1 : eol;
                }
                Long v = number(text.substring(i, Math.min(n, close + 1)));
                if (v != null) {
                    result.add(v);
                }
                i = close + 1;
                previous = 'v';
                continue;
            }
            if (Character.isJavaIdentifierStart(c)) {
                while (i < n && Character.isJavaIdentifierPart(text.charAt(i))) {
                    i++;
                }
                previous = 'v';
                continue;
            }
            if (Character.isDigit(c) || (c == '-' && i + 1 < n && Character.isDigit(text.charAt(i + 1)) && previous != 'v')) {
                int j = c == '-' ? i + 1 : i;
                while (j < n && (Character.isLetterOrDigit(text.charAt(j)) || text.charAt(j) == '_' || text.charAt(j) == '.')) {
                    j++;
                }
                int k = j;
                while (k < n && (text.charAt(k) == ' ' || text.charAt(k) == '\t')) {
                    k++;
                }
                boolean arithmetic = previous == 'o' || (k < n && "+-*/%".indexOf(text.charAt(k)) >= 0);
                Long v = number(text.substring(i, j));
                if (v != null && !arithmetic) { // n - 1, 2 * x: a computed value, not a literal input
                    result.add(v);
                }
                i = j;
                previous = 'v';
                continue;
            }
            previous = c == ')' || c == ']' || c == '}' ? 'v' : previous == 'v' && "+-*/%".indexOf(c) >= 0 ? 'o' : c;
            i++;
        }
        return result;
    }

    // ------------------------------------------------------------------ the code

    /**
     * The findings of one testable changed function. file: its file; fn: its symbol; changedLines: its own added lines
     * (1-based, new file); branches: its decision points; reaching: ids of the tests that really reach it (changed and
     * existing, direct or indirect, not mocked), in order; evidence: by test id.
     */
    public Result findings(CodeText file, Symbol fn, Collection<Integer> changedLines, int branches, List<String> reaching,
                           Map<String, Evidence> evidence) {
        List<Evidence> tests = reaching.stream().distinct().map(evidence::get).filter(java.util.Objects::nonNull).toList();
        List<CaseFinding> findings = new ArrayList<>(exceptions(file, fn, tests));
        List<Boundary> boundaries = boundaries(file, fn);
        Set<Long> covered = new TreeSet<>();
        tests.forEach(t -> covered.addAll(t.numbers()));
        for (Boundary b : boundaries) {
            List<String> missing = b.values().stream().filter(v -> !covered.contains(v)).map(String::valueOf).toList();
            List<String> by = tests.stream().filter(t -> b.values().stream().anyMatch(t.numbers()::contains)).map(Evidence::id).toList();
            findings.add(new CaseFinding(BOUNDARY, b.line(), lineText(file, b.line()), "Grenze " + b.label(), b.subject(),
                    missing.isEmpty(), by, covered.stream().map(String::valueOf).toList(), missing));
        }
        findings.addAll(effects(file, fn, changedLines, tests));
        findings.sort(Comparator.comparing((CaseFinding f) -> f.line() == null ? Integer.MAX_VALUE : f.line()));
        int n = (int) reaching.stream().distinct().count();
        if (n > 0 && branches > n) {
            findings.add(new CaseFinding(BRANCHES, null, null,
                    branches + " Verzweigungen, " + n + (n == 1 ? " Test" : " Tests"), null, false, List.of(), List.of(), List.of()));
        }
        return new Result(List.copyOf(findings), boundaries);
    }

    /** Error outcomes of the whole function, one per type (first throw site), and the tests that expect them. */
    private List<CaseFinding> exceptions(CodeText file, Symbol fn, List<Evidence> tests) {
        record Throw(int line, int col, String type, String call, Integer status) {
        }
        Map<String, Throw> found = new LinkedHashMap<>();
        int last = Math.min(fn.endLine(), file.code.size());
        for (int li = fn.startLine(); li <= last; li++) {
            String code = file.code.get(li - 1);
            List<Throw> onLine = new ArrayList<>();
            for (Pattern p : rules.exceptions()) {
                Matcher m = p.matcher(code);
                while (m.find()) {
                    int at = m.start();
                    if (onLine.stream().anyMatch(t -> t.col() == at)) {
                        continue;
                    }
                    String type = m.namedGroups().containsKey("type") ? m.group("type") : null;
                    String call = code.substring(m.start(), m.end()).replaceAll("\\s*\\(.*$", "").replaceAll("\\s+", " ").strip();
                    onLine.add(new Throw(li, at, type, call, status(type, statementFrom(file, li, m.end()))));
                }
            }
            onLine.sort(Comparator.comparingInt(Throw::col));
            onLine.forEach(t -> found.putIfAbsent(t.type() != null ? t.type() : t.call(), t));
        }
        List<CaseFinding> result = new ArrayList<>();
        for (Throw t : found.values()) {
            List<Pattern> checks = new ArrayList<>(rules.anyChecks());
            if (t.type() != null) {
                rules.typedChecks().forEach(tpl -> checks.add(template(tpl, Map.of("{type}", Pattern.quote(t.type())))));
            }
            if (t.status() != null) {
                String name = rules.statusNames().getOrDefault(t.status(), "");
                for (String tpl : rules.statusChecks()) {
                    if (name.isEmpty() && (tpl.contains("{statusName}") || tpl.contains("{statusCamel}"))) {
                        continue;
                    }
                    checks.add(template(tpl, Map.of("{status}", String.valueOf(t.status()), "{statusName}", Pattern.quote(name),
                            "{statusCamel}", Pattern.quote(camel(name)))));
                }
            }
            List<String> by = tests.stream().filter(e -> checks.stream().anyMatch(p -> p.matcher(e.text()).find())).map(Evidence::id).toList();
            String what = t.type() != null ? "wirft " + t.type() : "Fehlerausgang " + t.call() + "(…)";
            String label = what + (t.status() != null ? " (" + t.status() + ")" : "");
            result.add(new CaseFinding(EXCEPTION, t.line(), lineText(file, t.line()), label, t.type() != null ? t.type() : t.call(),
                    !by.isEmpty(), by, List.of(), List.of()));
        }
        return result;
    }

    /** The code of a statement from (line, col) on: up to the first ";" or three lines. */
    private static String statementFrom(CodeText file, int line, int col) {
        StringBuilder sb = new StringBuilder();
        for (int li = line; li <= Math.min(line + 2, file.code.size()); li++) {
            String c = file.code.get(li - 1);
            sb.append(li == line ? c.substring(Math.min(col, c.length())) : c).append(' ');
            if (c.contains(";")) {
                break;
            }
        }
        String s = sb.toString();
        int semi = s.indexOf(';');
        return semi < 0 ? s : s.substring(0, semi);
    }

    /** The HTTP status an exception maps to: by its type (rules "statuses"), else from its arguments; null when none. */
    private Integer status(String type, String arguments) {
        if (type != null && rules.statuses().containsKey(type)) {
            return rules.statuses().get(type);
        }
        Matcher c = STATUS_CONSTANT.matcher(arguments);
        while (c.find()) {
            String name = c.group(1) != null ? c.group(1) : c.group(2);
            for (Map.Entry<Integer, String> e : rules.statusNames().entrySet()) {
                if (e.getValue().equals(name) || camel(e.getValue()).equals(name)) {
                    return e.getKey();
                }
            }
            if (rules.statuses().containsKey(name)) {
                return rules.statuses().get(name);
            }
        }
        Matcher m = STATUS_CODE.matcher(arguments);
        while (m.find()) {
            int s = Integer.parseInt(m.group(1));
            if (s >= 400) {
                return s;
            }
        }
        return null;
    }

    /** NOT_FOUND -> NotFound. */
    static String camel(String constant) {
        StringBuilder sb = new StringBuilder();
        for (String part : constant.toLowerCase(Locale.ROOT).split("_")) {
            if (!part.isEmpty()) {
                sb.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
            }
        }
        return sb.toString();
    }

    /** Comparisons of a value with an integer or a same-file integer constant in the whole function, per value. */
    List<Boundary> boundaries(CodeText file, Symbol fn) {
        record Side(Set<Long> lower, Set<Long> upper, Set<Long> values, int line) {
        }
        Map<String, Side> byValue = new LinkedHashMap<>();
        int last = Math.min(fn.endLine(), file.code.size());
        for (int li = fn.startLine(); li <= last; li++) {
            String code = file.code.get(li - 1);
            if (FOR_HEADER.matcher(code).find()) {
                continue;
            }
            Matcher m = COMPARISON.matcher(code);
            int from = 0;
            while (from < code.length() && m.find(from)) {
                from = m.end(); // operands may be shared: a < b < c is no syntax we care about
                String left = m.group("left").replaceAll("\\s+", "");
                String right = m.group("right").replaceAll("\\s+", "");
                String op = m.group("op");
                Long bound = constant(file, right);
                String value = left;
                if (bound == null) {
                    bound = constant(file, left);
                    value = right;
                    op = switch (op) { // k < x  ==  x > k
                        case "<" -> ">";
                        case ">" -> "<";
                        case "<=" -> ">=";
                        default -> "<=";
                    };
                }
                if (bound == null || INTEGER.matcher(value).matches() || constant(file, value) != null || SIZE.matcher(value).find()) {
                    continue;
                }
                value = value.startsWith("this.") ? value.substring(5) : value;
                Side side = byValue.computeIfAbsent(value, k -> new Side(new TreeSet<>(), new TreeSet<>(), new TreeSet<>(), 0));
                if (side.line() == 0) {
                    side = new Side(side.lower(), side.upper(), side.values(), li);
                    byValue.put(value, side);
                }
                if (op.equals("<") || op.equals(">=")) {
                    side.lower().add(bound);
                    side.values().add(bound - 1);
                    side.values().add(bound);
                } else {
                    side.upper().add(bound);
                    side.values().add(bound);
                    side.values().add(bound + 1);
                }
            }
        }
        List<Boundary> result = new ArrayList<>();
        byValue.forEach((value, s) -> {
            String label;
            if (s.lower().size() == 1 && s.upper().size() == 1 && s.lower().iterator().next() <= s.upper().iterator().next()) {
                label = s.lower().iterator().next() + "…" + s.upper().iterator().next();
            } else {
                List<String> parts = new ArrayList<>();
                s.lower().forEach(k -> parts.add("≥ " + k));
                s.upper().forEach(k -> parts.add("≤ " + k));
                label = String.join(", ", parts);
            }
            result.add(new Boundary(value, label, List.copyOf(s.values()), s.line()));
        });
        return result;
    }

    /** An integer literal, or a same-file constant holding one (`MAX = 99`, `static final int MAX = 99;`); else null. */
    private Long constant(CodeText file, String operand) {
        if (INTEGER.matcher(operand).matches()) {
            return number(operand);
        }
        if (!operand.matches("[A-Za-z_$][\\w$]*")) {
            return null;
        }
        boolean upper = operand.matches("[A-Z][A-Z0-9_]*");
        Pattern declaration = compiled.computeIfAbsent("const:" + operand, k -> Pattern.compile(
                "(?:^|[\\s;,{(])(?<kw>(?:(?:const|final|val|readonly|static|let|var|private|public|protected|internal)\\s+)*)"
                        + "(?:[\\w$<>\\[\\]]+\\s+)?" + Pattern.quote(operand) + "\\s*(?::\\s*[\\w$<>\\[\\]]+\\s*)?=\\s*(?<value>-?\\d[\\d_]*[lL]?)\\s*(?:[;,]|$)"));
        for (String line : file.code) {
            Matcher m = declaration.matcher(line);
            if (m.find() && (upper || m.group("kw").matches(".*\\b(?:const|final|val|readonly)\\b.*"))) {
                return number(m.group("value"));
            }
        }
        return null;
    }

    /** Effects of the changed lines (one per kind and name, first line) and the tests whose assertions check them. */
    private List<CaseFinding> effects(CodeText file, Symbol fn, Collection<Integer> changedLines, List<Evidence> tests) {
        record Effect(String kind, String name, int line, String label, List<Pattern> checks) {
        }
        Map<String, Effect> found = new LinkedHashMap<>();
        List<Integer> lines = new ArrayList<>(new TreeSet<>(changedLines));
        lines.removeIf(l -> !fn.contains(l) || l > file.code.size());
        for (int li : lines) {
            String code = file.code.get(li - 1);
            for (Rules.EffectRule r : rules.effects()) {
                Matcher m = r.pattern().matcher(code);
                while (m.find()) {
                    String name = m.group("name");
                    if (name == null || name.isEmpty()) {
                        continue;
                    }
                    if ("field".equals(r.kind()) && Character.isUpperCase(name.charAt(0)) && m.group().contains("set" + name)) {
                        name = Character.toLowerCase(name.charAt(0)) + name.substring(1); // setJerseyNumber -> jerseyNumber
                    }
                    String n = name;
                    String quoted = Pattern.quote(n);
                    List<Pattern> checks = new ArrayList<>();
                    String label;
                    switch (r.kind()) {
                        case "field" -> {
                            rules.fieldChecks().forEach(t -> checks.add(template(t, Map.of("{name}", quoted))));
                            label = "setzt " + n;
                        }
                        case "persist" -> {
                            rules.callChecks().forEach(t -> checks.add(template(t, Map.of("{name}", quoted))));
                            checks.addAll(rules.readBack());
                            label = "speichert: " + n;
                        }
                        default -> {
                            rules.callChecks().forEach(t -> checks.add(template(t, Map.of("{name}", quoted))));
                            label = "sendet: " + n;
                        }
                    }
                    found.putIfAbsent(r.kind() + ":" + n, new Effect(r.kind(), n, li, label, checks));
                }
            }
        }
        for (Http.Call call : Http.calls(file.lines, lines.stream().map(l -> l - 1).toList())) {
            String[] parts = call.path().split("/");
            String segment = "";
            for (int i = parts.length - 1; i >= 0; i--) {
                if (!parts[i].isBlank() && !parts[i].contains("{")) {
                    segment = parts[i];
                    break;
                }
            }
            String quoted = Pattern.quote(segment);
            List<Pattern> checks = rules.httpChecks().stream().map(t -> template(t, Map.of("{segment}", quoted))).toList();
            String name = call.method() + " " + call.path();
            found.putIfAbsent("http:" + name, new Effect("http", name, call.line(), "ruft " + name, checks));
        }
        List<CaseFinding> result = new ArrayList<>();
        for (Effect e : found.values()) {
            List<String> by = tests.stream()
                    .filter(t -> t.assertions().stream().anyMatch(a -> e.checks().stream().anyMatch(p -> p.matcher(a).find())))
                    .map(Evidence::id).toList();
            result.add(new CaseFinding(EFFECT, e.line(), lineText(file, e.line()), e.label(), e.name(), !by.isEmpty(), by,
                    List.of(), List.of()));
        }
        return result;
    }

    /** A rules template with its placeholders replaced (values already quoted), compiled once. */
    private Pattern template(String template, Map<String, String> values) {
        String regex = template;
        for (Map.Entry<String, String> e : values.entrySet()) {
            regex = regex.replace(e.getKey(), e.getValue());
        }
        return compiled.computeIfAbsent(regex, Pattern::compile);
    }

    private static String lineText(CodeText file, int line) {
        return line >= 1 && line <= file.lines.size() ? file.lines.get(line - 1).strip() : null;
    }

    /** Distinct boundary values of a matrix's input columns that the matrix does not contain (sorted). */
    static List<String> missingIn(Boundary b, Set<Long> inputs) {
        Set<String> missing = new LinkedHashSet<>();
        b.values().stream().filter(v -> !inputs.contains(v)).forEach(v -> missing.add(String.valueOf(v)));
        return List.copyOf(missing);
    }
}
