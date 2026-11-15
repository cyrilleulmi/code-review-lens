package dev.smartcodereview.review;

import dev.smartcodereview.model.Model;
import dev.smartcodereview.model.Model.Analysis;
import dev.smartcodereview.model.Model.Category;
import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.DiffLine;
import dev.smartcodereview.model.Model.Flow;
import dev.smartcodereview.model.Model.Group;
import dev.smartcodereview.model.Model.Hunk;
import dev.smartcodereview.model.Model.LogEntry;
import dev.smartcodereview.model.Model.ReloadInfo;
import dev.smartcodereview.model.Model.ReviewState;
import dev.smartcodereview.model.Model.Segment;
import dev.smartcodereview.model.Model.Snapshot;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Carries the marks of review.json over a reload that brought new commits. Line keys (N/O + line number) are only
 * valid within one snapshot, so each changed line of the old snapshot is paired with an equal changed line of the
 * new one ({@link LineMatch}, per file, added and deleted lines separately). A mark moves with its line; marks on
 * lines that changed or vanished are dropped, so new code never shows up as reviewed. Works on file contents, not
 * commits, so it also survives force-pushes and rebases.
 * <p>
 * Marks at one place (okAt) move to the same place in the new analysis: groups keep their id (it comes from the
 * group's name), flows are numbered by order and are recognised by their entry point instead.
 */
public final class MarkCarry {

    private static final String SEP = "\u0000";

    private MarkCarry() {
    }

    /** Line keys in reading order: N12 before N100, O-lines after N-lines. */
    public static final Comparator<String> LINE_KEY_ORDER = Comparator
            .comparing((String k) -> k.isEmpty() ? ' ' : k.charAt(0))
            .thenComparingInt(k -> {
                try {
                    return Integer.parseInt(k.substring(1));
                } catch (RuntimeException e) {
                    return Integer.MAX_VALUE;
                }
            })
            .thenComparing(Comparator.naturalOrder());

    public static List<String> sortedKeys(Collection<String> keys) {
        return keys.stream().distinct().sorted(LINE_KEY_ORDER).toList();
    }

    /**
     * The state of the new snapshot. before/after: old and new snapshot; beforeAnalysis/afterAnalysis: their analyses
     * (only for the places of okAt). at: timestamp for the log and the reload info.
     */
    public static ReviewState carry(ReviewState state, Snapshot before, Analysis beforeAnalysis,
                                    Snapshot after, Analysis afterAnalysis, String at) {
        Map<String, String> lines = lineMap(before, after);
        Map<String, String> places = placeMap(beforeAnalysis, afterAnalysis);
        Set<String> kept = new HashSet<>();
        Set<String> lost = new HashSet<>();

        Map<String, Set<String>> ok = new TreeMap<>();
        state.ok().forEach((path, keys) -> keys.forEach(key -> {
            String from = path + SEP + key;
            String to = lines.get(from);
            if (to != null) {
                add(ok, to);
                kept.add(from);
            } else {
                lost.add(from);
            }
        }));
        Map<String, Map<String, Set<String>>> okAt = new TreeMap<>();
        state.okAt().forEach((place, byPath) -> byPath.forEach((path, keys) -> keys.forEach(key -> {
            String from = path + SEP + key;
            String to = lines.get(from);
            String newPlace = places.get(place);
            if (to != null && newPlace != null) {
                add(okAt.computeIfAbsent(newPlace, p -> new TreeMap<>()), to);
                kept.add(from);
            } else {
                lost.add(from);
            }
        })));
        lost.removeAll(kept);

        // new since the review: changed lines nothing was paired with, plus still open ones from earlier reloads
        Set<String> paired = new HashSet<>(lines.values());
        Map<String, Set<String>> fresh = new TreeMap<>();
        for (DiffFile f : after.files()) {
            for (DiffLine l : changedLines(f)) {
                if (!paired.contains(f.path() + SEP + l.key())) {
                    add(fresh, f.path() + SEP + l.key());
                }
            }
        }
        if (state.reload() != null && state.reload().newLines() != null) {
            state.reload().newLines().forEach((path, keys) -> keys.forEach(key -> {
                String to = lines.get(path + SEP + key);
                if (to != null && !ok.getOrDefault(path(to), Set.of()).contains(key(to))) {
                    add(fresh, to);
                }
            }));
        }

        String from = before.pr().headSha();
        String to = after.pr().headSha();
        List<LogEntry> log = new ArrayList<>(state.log());
        log.add(new LogEntry(at, "system", "carry", "reload:" + shortSha(from) + ".." + shortSha(to), kept.size()));
        return new ReviewState(Model.SCHEMA_VERSION, state.pr(), to, sorted(ok), log, sortedAt(okAt),
                new ReloadInfo(from, to, at, kept.size(), lost.size(), sorted(fresh)));
    }

    /** "path\0key" of the old snapshot -> "path\0key" of the new one, for every changed line that stayed the same. */
    static Map<String, String> lineMap(Snapshot before, Snapshot after) {
        Map<String, DiffFile> byPath = new HashMap<>();
        Map<String, DiffFile> byPrevious = new HashMap<>();
        Set<String> ambiguous = new HashSet<>();
        for (DiffFile f : after.files()) {
            byPath.put(f.path(), f);
            if (f.previousPath() != null && byPrevious.put(f.previousPath(), f) != null) {
                ambiguous.add(f.previousPath());
            }
        }
        ambiguous.forEach(byPrevious::remove);
        Map<String, String> result = new HashMap<>();
        for (DiffFile old : before.files()) {
            DiffFile now = byPath.get(old.path());
            if (now == null && old.previousPath() != null) {
                now = byPrevious.get(old.previousPath()); // renamed (again) since the last snapshot
            }
            if (now != null) {
                pair(old, now, "add", result);
                pair(old, now, "del", result);
            }
        }
        return result;
    }

    private static void pair(DiffFile old, DiffFile now, String type, Map<String, String> result) {
        List<DiffLine> a = changedLines(old).stream().filter(l -> type.equals(l.type())).toList();
        List<DiffLine> b = changedLines(now).stream().filter(l -> type.equals(l.type())).toList();
        if (a.isEmpty() || b.isEmpty()) {
            return;
        }
        int[] match = LineMatch.match(a.stream().map(DiffLine::text).toList(), b.stream().map(DiffLine::text).toList());
        for (int i = 0; i < match.length; i++) {
            if (match[i] >= 0) {
                result.put(old.path() + SEP + a.get(i).key(), now.path() + SEP + b.get(match[i]).key());
            }
        }
    }

    private static List<DiffLine> changedLines(DiffFile f) {
        List<DiffLine> result = new ArrayList<>();
        for (Hunk h : f.hunks() == null ? List.<Hunk>of() : f.hunks()) {
            for (DiffLine l : h.lines()) {
                if (l.changed() && l.key() != null && l.text() != null) {
                    result.add(l);
                }
            }
        }
        return result;
    }

    /** Old place id -> new place id: same group id, or for flows the flow with the same entry point. */
    static Map<String, String> placeMap(Analysis before, Analysis after) {
        Map<String, String> result = new HashMap<>();
        if (before == null || after == null) {
            return result;
        }
        Map<String, String> bySignature = new HashMap<>();
        Set<String> ambiguous = new HashSet<>();
        signatures(after).forEach((place, signature) -> {
            if (bySignature.put(signature, place) != null) {
                ambiguous.add(signature);
            }
        });
        ambiguous.forEach(bySignature::remove);
        signatures(before).forEach((place, signature) -> {
            String now = bySignature.get(signature);
            if (now != null) {
                result.put(place, now);
            }
        });
        return result;
    }

    /** place id -> what identifies it across analyses. */
    private static Map<String, String> signatures(Analysis analysis) {
        Map<String, Segment> segments = new HashMap<>();
        analysis.segments().forEach(s -> segments.put(s.id(), s));
        Map<String, Flow> flows = new HashMap<>();
        (analysis.flows() == null ? List.<Flow>of() : analysis.flows()).forEach(f -> flows.put(f.id(), f));
        Map<String, String> result = new HashMap<>();
        for (Category c : analysis.categories()) {
            for (Group g : c.groups()) {
                Flow flow = g.flowId() == null ? null : flows.get(g.flowId());
                result.put(g.id(), flow == null ? "group:" + g.id() : flowSignature(flow, segments));
            }
        }
        return result;
    }

    /** A flow is its entry point (the first step): file and symbol, else its title. */
    private static String flowSignature(Flow flow, Map<String, Segment> segments) {
        Segment entry = flow.steps().isEmpty() ? null : segments.get(flow.steps().getFirst().segmentId());
        if (entry == null) {
            return "flow-title:" + flow.title();
        }
        return "flow:" + entry.path() + "#" + (entry.symbol() != null ? entry.symbol() : flow.title());
    }

    private static void add(Map<String, Set<String>> byPath, String pathKey) {
        byPath.computeIfAbsent(path(pathKey), p -> new TreeSet<>()).add(key(pathKey));
    }

    private static String path(String pathKey) {
        return pathKey.substring(0, pathKey.indexOf(SEP));
    }

    private static String key(String pathKey) {
        return pathKey.substring(pathKey.indexOf(SEP) + 1);
    }

    private static Map<String, List<String>> sorted(Map<String, Set<String>> byPath) {
        Map<String, List<String>> result = new TreeMap<>();
        byPath.forEach((path, keys) -> {
            if (!keys.isEmpty()) {
                result.put(path, sortedKeys(keys));
            }
        });
        return result;
    }

    private static Map<String, Map<String, List<String>>> sortedAt(Map<String, Map<String, Set<String>>> byPlace) {
        Map<String, Map<String, List<String>>> result = new TreeMap<>();
        byPlace.forEach((place, byPath) -> {
            Map<String, List<String>> s = sorted(byPath);
            if (!s.isEmpty()) {
                result.put(place, s);
            }
        });
        return result;
    }

    private static String shortSha(String sha) {
        return sha == null ? "?" : sha.substring(0, Math.min(7, sha.length()));
    }
}
