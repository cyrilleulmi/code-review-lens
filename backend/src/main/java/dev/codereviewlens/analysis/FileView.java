package dev.codereviewlens.analysis;

import dev.codereviewlens.model.Model.DiffLine;
import dev.codereviewlens.model.Model.DisplayLine;
import dev.codereviewlens.model.Model.Hunk;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The whole new version of a file with the deleted lines woven in at their positions. Lets us show any
 * range (e.g. a complete function) with diff colouring, not just the 3 context lines of a hunk.
 */
public final class FileView {

    /** pos: the new-file line this entry sits at; deleted lines sit just before line `pos`. */
    public record Entry(String type, Integer oldLine, Integer newLine, String key, String text, boolean inDiff, int pos) {
        public boolean changed() {
            return !"ctx".equals(type);
        }

        public boolean inRange(int start, int end) {
            return "del".equals(type) ? pos > start && pos <= end : pos >= start && pos <= end;
        }
    }

    public final List<Entry> entries;

    private FileView(List<Entry> entries) {
        this.entries = entries;
    }

    public static FileView build(List<String> lines, List<Hunk> hunks) {
        int lineCount = lines.size();
        if (lineCount > 0 && lines.get(lineCount - 1).isEmpty()) {
            lineCount--; // trailing newline
        }
        Map<Integer, DiffLine> adds = new HashMap<>();
        Map<Integer, List<DiffLine>> delsBefore = new HashMap<>();
        Map<Integer, Integer> oldByNew = new HashMap<>();
        Set<Integer> inDiff = new HashSet<>();
        List<Hunk> sorted = new ArrayList<>(hunks);
        sorted.sort(Comparator.comparingInt(Hunk::newStart));

        for (Hunk h : sorted) {
            int cur = h.newStart();
            for (DiffLine l : h.lines()) {
                switch (l.type()) {
                    case "add" -> {
                        adds.put(l.newLine(), l);
                        cur = l.newLine() + 1;
                    }
                    case "ctx" -> {
                        oldByNew.put(l.newLine(), l.oldLine());
                        cur = l.newLine() + 1;
                    }
                    default -> delsBefore.computeIfAbsent(cur, k -> new ArrayList<>()).add(l);
                }
            }
            for (int n = h.newStart(); n < h.newStart() + h.newLines(); n++) {
                inDiff.add(n);
            }
        }

        List<Entry> entries = new ArrayList<>(lineCount + 16);
        int delta = 0;
        int hunkIdx = 0;
        for (int n = 1; n <= lineCount + 1; n++) {
            while (hunkIdx < sorted.size() && sorted.get(hunkIdx).newStart() + sorted.get(hunkIdx).newLines() - 1 < n) {
                delta += sorted.get(hunkIdx).newLines() - sorted.get(hunkIdx).oldLines();
                hunkIdx++;
            }
            for (DiffLine d : delsBefore.getOrDefault(n, List.of())) {
                entries.add(new Entry("del", d.oldLine(), null, d.key(), d.text(), true, n));
            }
            if (n > lineCount) {
                break;
            }
            DiffLine a = adds.get(n);
            if (a != null) {
                entries.add(new Entry("add", null, n, a.key(), a.text(), true, n));
            } else {
                Integer old = oldByNew.getOrDefault(n, n - delta);
                entries.add(new Entry("ctx", old, n, "N" + n, lines.get(n - 1), inDiff.contains(n), n));
            }
        }
        return new FileView(entries);
    }

    /**
     * The whole file as display lines, deleted lines at their positions: no gaps, and no line is anybody's own
     * (the UI puts the lines of its segments in place, by key). A file without a new version (removed) consists of
     * the lines of its hunks.
     */
    public static List<DisplayLine> whole(List<String> lines, List<Hunk> hunks) {
        if (lines.isEmpty() || (lines.size() == 1 && lines.getFirst().isEmpty())) {
            return hunks.stream().flatMap(h -> h.lines().stream())
                    .map(l -> new DisplayLine(l.type(), l.oldLine(), l.newLine(), l.key(), l.text(), false, true, null, null))
                    .toList();
        }
        return build(lines, hunks).entries.stream()
                .map(e -> new DisplayLine(e.type(), e.oldLine(), e.newLine(), e.key(), e.text(), false, e.inDiff(), null, null))
                .toList();
    }

    /** Where a changed line sits in the new file (for deleted lines: the line right after the gap). */
    public static int anchorOf(DiffLine line, Hunk hunk) {
        if (line.newLine() != null) {
            return line.newLine();
        }
        int cur = hunk.newStart();
        for (DiffLine l : hunk.lines()) {
            if (l == line) {
                return cur;
            }
            if (l.newLine() != null) {
                cur = l.newLine() + 1;
            }
        }
        return cur;
    }
}
