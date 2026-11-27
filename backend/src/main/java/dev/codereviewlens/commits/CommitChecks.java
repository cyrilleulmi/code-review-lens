package dev.codereviewlens.commits;

import dev.codereviewlens.analysis.CodeText;
import dev.codereviewlens.analysis.Expectations;
import dev.codereviewlens.analysis.Expectations.Assertion;
import dev.codereviewlens.analysis.Languages;
import dev.codereviewlens.analysis.Rules;
import dev.codereviewlens.analysis.SetupImpact;
import dev.codereviewlens.analysis.SymbolExtractor.Symbol;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.CodeCoverage;
import dev.codereviewlens.model.Model.Commit;
import dev.codereviewlens.model.Model.CommitFinding;
import dev.codereviewlens.model.Model.Commits;
import dev.codereviewlens.model.Model.Segment;
import dev.codereviewlens.model.Model.TestInfo;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Commit-Bezug der Tests: what the order of a PR's commits says about its tests, which the final diff hides. Works on
 * the attribution (commits.json: which commit made each changed line) and the analysis (test cases, testable code and
 * which tests reach it); pattern-based and deterministic, patterns in the rules section "commitChecks".
 * <ul>
 * <li>expectation-later: an assertion of a test written in this PR whose lines come from a later commit than the
 * test's declaration line - the test was written, then its expectation was changed. "warn" when that later commit
 * changes only test files or its title is a test adjustment ("fix tests"), else "info".</li>
 * <li>fix-without-test: a commit whose title is a fix (and no test adjustment) changes source code and no test file.</li>
 * <li>logic-without-test ("info"): a commit changes testable code (Analysis.coverage) and no test file, and no later
 * commit changes a test that reaches that code. A test written before the code (test first) counts as well.</li>
 * </ul>
 * Merge commits, commits of merged side branches (mergedVia) and commits whose diff is unknown are skipped.
 */
public final class CommitChecks {

    public static final String EXPECTATION_LATER = "expectation-later";
    public static final String FIX_WITHOUT_TEST = "fix-without-test";
    public static final String LOGIC_WITHOUT_TEST = "logic-without-test";
    public static final String WARN = "warn";
    public static final String INFO = "info";

    private static final List<String> KIND_ORDER = List.of(FIX_WITHOUT_TEST, EXPECTATION_LATER, LOGIC_WITHOUT_TEST);
    private static final int MAX_CODE = 120;

    private final Rules rules;
    private final Commits commits;
    private final Analysis analysis;
    private final Map<String, String> sources;
    private final Map<String, Integer> order = new HashMap<>();
    private final Map<String, Commit> bySha = new HashMap<>();
    private final Map<String, Segment> segments = new HashMap<>();
    /** "path\0key" -> segment id owning that line */
    private final Map<String, String> segmentOfLine = new HashMap<>();

    private CommitChecks(Rules rules, Commits commits, Analysis analysis, Map<String, String> sources) {
        this.rules = rules;
        this.commits = commits;
        this.analysis = analysis;
        this.sources = sources;
        List<Commit> list = commits.commits();
        for (int i = 0; i < list.size(); i++) {
            order.putIfAbsent(list.get(i).sha(), i);
            bySha.putIfAbsent(list.get(i).sha(), list.get(i));
        }
        for (Segment s : analysis.segments() == null ? List.<Segment>of() : analysis.segments()) {
            segments.put(s.id(), s);
            s.lineKeys().forEach(k -> segmentOfLine.putIfAbsent(s.path() + "\u0000" + k, s.id()));
        }
    }

    /**
     * The findings for a PR, by commit order, then fix / expectation / logic, then path and line. sources: path -> text
     * at the PR head of the changed test files (others are not needed).
     */
    public static List<CommitFinding> find(Rules rules, Commits commits, Analysis analysis, Map<String, String> sources) {
        if (commits == null || commits.commits() == null || commits.commits().isEmpty() || analysis == null) {
            return List.of();
        }
        return new CommitChecks(rules, commits, analysis, sources == null ? Map.of() : sources).run();
    }

    private List<CommitFinding> run() {
        List<CommitFinding> result = new ArrayList<>();
        Set<String> fixes = new LinkedHashSet<>();
        fixWithoutTest(result, fixes);
        expectationLater(result);
        logicWithoutTest(result, fixes);
        result.sort(Comparator.comparingInt((CommitFinding f) -> order.getOrDefault(f.sha(), Integer.MAX_VALUE))
                .thenComparingInt(f -> KIND_ORDER.indexOf(f.kind()))
                .thenComparing(f -> f.path() == null ? "" : f.path())
                .thenComparingInt(f -> lineNumber(f.lineKey())));
        return result;
    }

    // ------------------------------------------------------------------ fix without test

    private void fixWithoutTest(List<CommitFinding> out, Set<String> fixes) {
        for (Commit c : commits.commits()) {
            if (!usable(c) || !rules.commitChecks.isFix(c.title()) || touchesTests(c)) {
                continue;
            }
            List<String> code = c.files().stream().filter(this::isCode).toList();
            if (code.isEmpty()) {
                continue;
            }
            fixes.add(c.sha());
            String path = code.getFirst();
            String key = null;
            for (String p : code) {
                String k = firstKey(p, c.sha(), null);
                if (k != null) {
                    path = p;
                    key = k;
                    break;
                }
            }
            String names = String.join(", ", code.stream().map(CommitChecks::fileName).toList());
            out.add(new CommitFinding(FIX_WITHOUT_TEST, WARN, c.sha(), c.title(), path, key,
                    key == null ? null : segmentOfLine.get(path + "\u0000" + key), null,
                    "Der Commit ist ein Fix (Titel «" + c.title() + "») und ändert Code (" + names
                            + "), aber keinen Test. Ein Test, der den Fehler zeigt, fehlt im Commit."));
        }
    }

    // ------------------------------------------------------------------ expectation adjusted later

    private void expectationLater(List<CommitFinding> out) {
        if (analysis.tests() == null) {
            return;
        }
        Expectations expectations = new Expectations(rules);
        Map<String, CodeText> texts = new HashMap<>();
        for (TestInfo t : analysis.tests()) {
            Segment s = segments.get(t.segmentId());
            Map<String, String> byKey = commits.lines() == null ? null : commits.lines().get(t.path());
            String source = sources.get(t.path());
            if (s == null || s.startLine() == null || s.endLine() == null || byKey == null || source == null) {
                continue;
            }
            CodeText text = texts.computeIfAbsent(t.path(), p -> CodeText.of(source));
            Symbol symbol = new Symbol(s.symbol(), s.symbolKind(), s.startLine(), s.endLine(), null);
            int decl = Expectations.declarationLine(text, symbol);
            String declSha = byKey.get("N" + decl);
            Integer declIndex = declSha == null ? null : order.get(declSha);
            if (declIndex == null) {
                continue; // the test is older than the PR (or its line has no commit): nothing to compare with
            }
            for (Assertion a : expectations.assertions(text, symbol)) {
                String laterSha = null;
                String laterKey = null;
                int laterIndex = declIndex;
                for (int line = a.line(); line <= a.endLine(); line++) {
                    String sha = byKey.get("N" + line);
                    Integer i = sha == null ? null : order.get(sha);
                    if (i != null && i > laterIndex) {
                        laterIndex = i;
                        laterSha = sha;
                        laterKey = "N" + line;
                    }
                }
                Commit later = laterSha == null ? null : bySha.get(laterSha);
                if (later == null || !usable(later)) {
                    continue;
                }
                boolean testOnly = later.files().stream().allMatch(this::isTest);
                boolean titled = rules.commitChecks.isTestAdjust(later.title());
                List<String> why = new ArrayList<>();
                if (testOnly) {
                    why.add("der Commit ändert nur Tests");
                }
                if (titled) {
                    why.add("sein Titel passt Tests an");
                }
                Commit written = bySha.get(declSha);
                String detail = "Test geschrieben in " + shortSha(declSha) + " «" + written.title() + "», Erwartung "
                        + "nachträglich in " + shortSha(laterSha) + " «" + later.title() + "» geändert: "
                        + clip(a.text()) + (why.isEmpty()
                        ? ". Der Commit ändert auch anderes – vielleicht ein gewolltes neues Verhalten."
                        : ". Verdächtig: " + String.join(", ", why) + " – wurde der Test an den Code angepasst?");
                out.add(new CommitFinding(EXPECTATION_LATER, testOnly || titled ? WARN : INFO, laterSha, later.title(),
                        t.path(), laterKey, segmentOfLine.getOrDefault(t.path() + "\u0000" + laterKey, s.id()), s.id(),
                        detail));
            }
        }
    }

    // ------------------------------------------------------------------ logic without test

    private void logicWithoutTest(List<CommitFinding> out, Set<String> fixes) {
        if (analysis.coverage() == null) {
            return;
        }
        Map<String, Set<Integer>> testCommits = new HashMap<>();
        for (TestInfo t : analysis.tests() == null ? List.<TestInfo>of() : analysis.tests()) {
            Segment s = segments.get(t.segmentId());
            if (s != null) {
                testCommits.put(s.id(), commitIndexes(s));
            }
        }
        for (CodeCoverage cv : analysis.coverage()) {
            Segment s = segments.get(cv.segmentId());
            if (s == null) {
                continue;
            }
            List<String> reaching = new ArrayList<>();
            if (cv.directTests() != null) {
                reaching.addAll(cv.directTests());
            }
            if (cv.indirectTests() != null) {
                reaching.addAll(cv.indirectTests());
            }
            Set<Integer> own = commitIndexes(s);
            if (own.isEmpty()) {
                continue;
            }
            int first = own.stream().min(Integer::compare).orElseThrow();
            for (int index : own) {
                Commit c = commits.commits().get(index);
                if (!usable(c) || fixes.contains(c.sha()) || touchesTests(c)) {
                    continue;
                }
                boolean testedLater = reaching.stream()
                        .anyMatch(t -> testCommits.getOrDefault(t, Set.of()).stream().anyMatch(i -> i > index));
                boolean testFirst = index == first && reaching.stream()
                        .anyMatch(t -> testCommits.getOrDefault(t, Set.of()).stream().anyMatch(i -> i < index));
                if (testedLater || testFirst) {
                    continue;
                }
                String key = firstKey(s.path(), c.sha(), Set.copyOf(s.lineKeys()));
                String name = s.symbol() != null ? s.symbol() : fileName(s.path());
                String why = switch (cv.status()) {
                    case "none" -> "Kein Test erreicht diesen Code.";
                    case "existing" -> "Nur bestehende, unveränderte Tests erreichen diesen Code – keiner wurde dafür angepasst.";
                    default -> "Die Tests, die diesen Code erreichen, stammen aus früheren Commits; kein späterer Commit "
                            + "passt sie an.";
                };
                out.add(new CommitFinding(LOGIC_WITHOUT_TEST, INFO, c.sha(), c.title(), s.path(), key, s.id(), null,
                        name + " geändert in " + shortSha(c.sha()) + ", ohne Test im Commit. " + why));
            }
        }
    }

    /** Positions of the commits that made the changed lines of a segment. */
    private Set<Integer> commitIndexes(Segment s) {
        Set<Integer> result = new java.util.TreeSet<>();
        Map<String, String> byKey = commits.lines() == null ? null : commits.lines().get(s.path());
        if (byKey == null) {
            return result;
        }
        for (String k : s.lineKeys()) {
            Integer i = byKey.get(k) == null ? null : order.get(byKey.get(k));
            if (i != null) {
                result.add(i);
            }
        }
        return result;
    }

    // ------------------------------------------------------------------ helpers

    /** Merge commits, commits of merged side branches and commits without a known diff say nothing. */
    private boolean usable(Commit c) {
        boolean merge = c.parents() != null && c.parents().size() > 1;
        boolean side = commits.mergedVia() != null && commits.mergedVia().containsKey(c.sha());
        boolean noDiff = c.files() == null || c.files().isEmpty();
        return !merge && !side && !noDiff;
    }

    private boolean touchesTests(Commit c) {
        return c.files().stream().anyMatch(this::isTest);
    }

    /** Test files: the path rule of category tests, or a test-support path. */
    private boolean isTest(String path) {
        return SetupImpact.isTestOrSupport(rules, path);
    }

    /** Source code to be tested: a code language, no test file, not excluded by commitChecks.notCode. */
    private boolean isCode(String path) {
        return Languages.hasSymbols(Languages.of(path)) && !isTest(path) && !rules.commitChecks.isNotCode(path);
    }

    /** The first line key (N before O, by number) of a file made by a commit, optionally within some keys. */
    private String firstKey(String path, String sha, Set<String> within) {
        Map<String, String> byKey = commits.lines() == null ? null : commits.lines().get(path);
        if (byKey == null) {
            return null;
        }
        TreeMap<String, String> sorted = new TreeMap<>(KEY_ORDER);
        byKey.forEach((k, v) -> {
            if (sha.equals(v) && (within == null || within.contains(k))) {
                sorted.put(k, v);
            }
        });
        return sorted.isEmpty() ? null : sorted.firstKey();
    }

    private static final Comparator<String> KEY_ORDER = Comparator
            .comparing((String k) -> k.isEmpty() ? ' ' : k.charAt(0))
            .thenComparingInt(CommitChecks::lineNumber)
            .thenComparing(Comparator.naturalOrder());

    private static int lineNumber(String key) {
        if (key == null || key.length() < 2) {
            return Integer.MAX_VALUE;
        }
        try {
            return Integer.parseInt(key.substring(1));
        } catch (NumberFormatException e) {
            return Integer.MAX_VALUE;
        }
    }

    private static String fileName(String path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    private static String shortSha(String sha) {
        return sha.length() > 7 ? sha.substring(0, 7) : sha;
    }

    private static String clip(String text) {
        String t = text == null ? "" : text.strip();
        return "«" + (t.length() > MAX_CODE ? t.substring(0, MAX_CODE - 1) + "…" : t) + "»";
    }
}
