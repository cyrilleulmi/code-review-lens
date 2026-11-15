package dev.smartcodereview.analysis;

import dev.smartcodereview.model.Model.CodeCoverage;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Test coverage seen from the code (see {@link CodeCoverage}): how complex a changed function is and how to order
 * the list. Deterministic and deliberately simple - it counts, it does not parse.
 */
final class Coverage {

    static final String DIRECT = "direct";
    static final String INDIRECT = "indirect";
    static final String NONE = "none";

    /**
     * A decision point: the keywords if (also "else if", counted once), elif, case, catch, except, for, while; the
     * operators && and ||; and a ternary "?" - only a "?" with whitespace (or the line end) on both sides, so that
     * "?.", "??", "?:" (TS optional, Kotlin elvis), generics "<?>" and nullable types "String?" do not count.
     * Not counted: else, default, Kotlin when-arms, Python and/or.
     */
    private static final Pattern BRANCH = Pattern.compile(
            "\\b(?:if|elif|case|catch|except|for|while)\\b|&&|\\|\\||(?<!\\S)\\?(?!\\S)");

    /**
     * The whole body of a trivial accessor: `return this.x;`, `return x;` (also one qualifier like a Go receiver,
     * `return p.x`) or an assignment of a plain name, `this.x = x;` / `x = value;`.
     */
    private static final Pattern ACCESSOR_BODY = Pattern.compile(
            "(?:return\\s+(?:[\\w$]+\\.)?[\\w$]+|(?:[\\w$]+\\.)?[\\w$]+\\s*=\\s*[\\w$]+)\\s*;?");

    private static final Map<String, Integer> STATUS_ORDER = Map.of(NONE, 0, INDIRECT, 1, DIRECT, 2);

    /** Untested first, then only indirectly tested, then tested; within each the highest risk first (stable). */
    static final Comparator<CodeCoverage> ORDER = Comparator
            .comparingInt((CodeCoverage c) -> STATUS_ORDER.getOrDefault(c.status(), 3))
            .thenComparing(Comparator.comparingInt(CodeCoverage::risk).reversed());

    private Coverage() {
    }

    /** Decision points in code lines whose strings and comments are blanked out ({@link CodeText#code}). */
    static int branches(List<String> code) {
        int n = 0;
        for (String line : code) {
            Matcher m = BRANCH.matcher(line);
            while (m.find()) {
                n++;
            }
        }
        return n;
    }

    /**
     * A getter or setter that does nothing but return or assign a field (Java getX/setX, TS get/set): the code
     * between the first "{" and the last "}" of the function (strings and comments blanked out, see
     * {@link CodeText#code}) is a single statement {@code return this.x;}, {@code return x;}, {@code this.x = x;} or
     * {@code x = value;}. Bodies without braces (arrow functions, Kotlin {@code = field}) never count, so a doubtful
     * case stays in the coverage.
     */
    static boolean isTrivialAccessor(List<String> code) {
        String text = String.join("\n", code);
        int open = text.indexOf('{');
        int close = text.lastIndexOf('}');
        if (open < 0 || close <= open) {
            return false;
        }
        return ACCESSOR_BODY.matcher(text.substring(open + 1, close).strip()).matches();
    }

    /** Sort key: more changed lines and more branches = more that can go wrong untested. */
    static int risk(int changedLines, int branches) {
        return changedLines * (1 + branches);
    }
}
