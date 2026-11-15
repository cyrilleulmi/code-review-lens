package dev.smartcodereview.analysis;

import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.RelatedTestFile;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Bestehende Tests, stage A: which existing, unchanged test files of the repository most likely test the changed code
 * - by name, without reading any file. Pure and deterministic; the caller loads the selected files (see ReviewService)
 * and {@link Analyzer} links their test cases to the changed code.
 * <p>
 * For every changed source file (not removed, a language with symbols, no test, no path rule that skips symbols):
 * <ul>
 *   <li><b>mirror</b>: a test file named after it ({@link Analyzer#TEST_FILE}: X.spec.ts, X.test.ts, XTest.java,
 *       XTests.java, XIT.java, x_test.go, ...) in its own directory or in a mirrored test directory (rules
 *       "relatedTests.mirrors": src/main/java/a/X.java -&gt; src/test/java/a/XTest.java);</li>
 *   <li><b>name</b>: only when there is no such file, a test file of that name elsewhere - the nearest ones (longest
 *       common directory prefix), so that a generic name (index.spec.ts) does not pull in the whole repository;</li>
 *   <li><b>prefix</b>: test files in those directories whose unit name starts with the file name, followed by a new
 *       camel-case word or a dot part (PlayerResourceSecurityTest for PlayerResource, player-list.component.spec.ts for
 *       player-list.ts; not player-list.spec.ts for player.ts).</li>
 * </ul>
 * Only test files (path rule of category tests, a language with symbols, same language family) that are not part of
 * the pull request count. Order: mirror, then name, then prefix; within each by changed file, then test path. At most
 * "relatedTests.limit" files are taken; when that cuts, the result says so.
 */
public final class RelatedTests {

    public static final String MIRROR = "mirror";
    public static final String NAME = "name";
    public static final String PREFIX = "prefix";
    private static final List<String> RANK = List.of(MIRROR, NAME, PREFIX);

    /** The selection: files in order (loaded = false), how many qualified, whether the limit cut. */
    public record Selection(List<RelatedTestFile> files, int candidates, boolean truncated) {
    }

    private RelatedTests() {
    }

    /** repositoryFiles: all file paths of the repository at the PR head; changed: the files of the pull request. */
    public static Selection select(Rules rules, List<DiffFile> changed, List<String> repositoryFiles) {
        Set<String> inPr = new HashSet<>();
        for (DiffFile f : changed) {
            inPr.add(f.path());
            if (f.previousPath() != null) {
                inPr.add(f.previousPath());
            }
        }
        Map<String, List<String>> byUnit = new HashMap<>();
        Map<String, List<String>> byDir = new HashMap<>();
        for (String path : repositoryFiles == null ? List.<String>of() : repositoryFiles) {
            String unit = Analyzer.unitOf(path);
            if (unit == null || inPr.contains(path) || !isTestFile(rules, path)) {
                continue;
            }
            byUnit.computeIfAbsent(unit, k -> new ArrayList<>()).add(path);
            byDir.computeIfAbsent(dirOf(path), k -> new ArrayList<>()).add(path);
        }

        record Candidate(String test, String reason, String source) {
        }
        List<Candidate> candidates = new ArrayList<>();
        List<DiffFile> sources = changed.stream().filter(f -> isSource(rules, f))
                .sorted(Comparator.comparing(DiffFile::path)).toList();
        for (DiffFile source : sources) {
            String path = source.path();
            String stem = stemOf(fileName(path));
            String language = source.language();
            Set<String> dirs = mirroredDirs(dirOf(path), rules.relatedTests.mirrors());
            List<String> named = byUnit.getOrDefault(stem, List.of()).stream()
                    .filter(t -> sameFamily(language, Languages.of(t))).sorted().toList();
            List<String> mirrored = named.stream().filter(t -> dirs.contains(dirOf(t))).toList();
            mirrored.forEach(t -> candidates.add(new Candidate(t, MIRROR, path)));
            if (mirrored.isEmpty() && !named.isEmpty()) {
                int best = named.stream().mapToInt(t -> commonDirs(dirOf(t), dirOf(path))).max().orElse(0);
                named.stream().filter(t -> commonDirs(dirOf(t), dirOf(path)) == best)
                        .forEach(t -> candidates.add(new Candidate(t, NAME, path)));
            }
            for (String dir : dirs) {
                byDir.getOrDefault(dir, List.of()).stream()
                        .filter(t -> sameFamily(language, Languages.of(t)) && startsWithWord(Analyzer.unitOf(t), stem))
                        .sorted()
                        .forEach(t -> candidates.add(new Candidate(t, PREFIX, path)));
            }
        }

        // one entry per test file: its best reason, all changed files it was found for
        Map<String, String> reason = new LinkedHashMap<>();
        Map<String, Set<String>> forSources = new HashMap<>();
        for (Candidate c : candidates) {
            reason.merge(c.test(), c.reason(), (a, b) -> RANK.indexOf(a) <= RANK.indexOf(b) ? a : b);
            forSources.computeIfAbsent(c.test(), k -> new LinkedHashSet<>()).add(c.source());
        }
        Comparator<String> order = Comparator.comparingInt((String t) -> RANK.indexOf(reason.get(t)))
                .thenComparing(t -> forSources.get(t).stream().sorted().findFirst().orElse(""))
                .thenComparing(Comparator.naturalOrder());
        List<String> all = reason.keySet().stream().sorted(order).toList();
        int limit = rules.relatedTests.limit();
        List<RelatedTestFile> files = all.stream().limit(limit)
                .map(t -> new RelatedTestFile(t, reason.get(t), forSources.get(t).stream().sorted().toList(), false))
                .toList();
        return new Selection(files, all.size(), all.size() > limit);
    }

    /** Changed code whose existing tests are looked for: not removed, with symbols, not a test, not generated. */
    static boolean isSource(Rules rules, DiffFile f) {
        if ("removed".equals(f.status()) || !Languages.hasSymbols(f.language())) {
            return false;
        }
        Rules.Rule r = rules.forPath(f.path());
        return r == null || (r.symbols() && !"tests".equals(r.category()));
    }

    /** A test file by the path rule of category tests, in a language with symbols. */
    static boolean isTestFile(Rules rules, String path) {
        Rules.Rule r = rules.forPath(path);
        return r != null && "tests".equals(r.category()) && Languages.hasSymbols(Languages.of(path));
    }

    /** The directory itself, then every mirror applied to it (first occurrence of whole path segments). */
    static Set<String> mirroredDirs(String dir, List<Rules.Mirror> mirrors) {
        Set<String> result = new LinkedHashSet<>();
        result.add(dir);
        String padded = "/" + dir + "/";
        for (Rules.Mirror m : mirrors) {
            String from = "/" + trimSlashes(m.from()) + "/";
            int at = padded.indexOf(from);
            if (at < 0 || trimSlashes(m.from()).isEmpty()) {
                continue;
            }
            String to = trimSlashes(m.to());
            String mapped = padded.substring(0, at) + (to.isEmpty() ? "/" : "/" + to + "/") + padded.substring(at + from.length());
            result.add(trimSlashes(mapped.replaceAll("/+", "/")));
        }
        return result;
    }

    /**
     * unit starts with stem and continues with a new camel-case word or a dot part: PlayerResource|Security,
     * player-list|.component. Not after "-" or "_": player-list is another unit than player.
     */
    static boolean startsWithWord(String unit, String stem) {
        if (unit == null || unit.length() <= stem.length() || !unit.startsWith(stem)) {
            return false;
        }
        char next = unit.charAt(stem.length());
        return Character.isUpperCase(next) || next == '.';
    }

    /** TS and JS test each other; Java and Kotlin too. */
    private static boolean sameFamily(String a, String b) {
        return family(a).equals(family(b));
    }

    private static String family(String language) {
        return switch (language) {
            case "typescript", "javascript" -> "js";
            case "java", "kotlin" -> "jvm";
            default -> language;
        };
    }

    private static int commonDirs(String a, String b) {
        String[] x = a.split("/");
        String[] y = b.split("/");
        int i = 0;
        while (i < x.length && i < y.length && x[i].equals(y[i])) {
            i++;
        }
        return i;
    }

    private static String trimSlashes(String s) {
        int start = 0, end = s.length();
        while (start < end && s.charAt(start) == '/') {
            start++;
        }
        while (end > start && s.charAt(end - 1) == '/') {
            end--;
        }
        return s.substring(start, end);
    }

    static String dirOf(String path) {
        return path.contains("/") ? path.substring(0, path.lastIndexOf('/')) : "";
    }

    private static String fileName(String path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    private static String stemOf(String fileName) {
        return fileName.contains(".") ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;
    }
}
