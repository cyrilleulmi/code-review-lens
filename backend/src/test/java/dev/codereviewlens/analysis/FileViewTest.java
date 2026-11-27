package dev.codereviewlens.analysis;

import dev.codereviewlens.diff.PatchParser;
import dev.codereviewlens.model.Model.DisplayLine;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FileViewTest {

    /** New version: seven lines; the patch replaces line 2 by two lines, the rest of the file is outside the diff. */
    private static final String SOURCE = "a\nB\nc\nd\ne\nf\ng\n";
    private static final String PATCH = "@@ -1,3 +1,4 @@ class A\n a\n-b\n+B\n+c\n d";

    private static List<DisplayLine> whole(String source, String patch) {
        return FileView.whole(CodeText.of(source).lines, PatchParser.parse(patch));
    }

    @Test
    void wholeFileHasEveryLineWithTheDeletedOnesWovenIn() {
        List<DisplayLine> lines = whole(SOURCE, PATCH);
        assertEquals(List.of("ctx", "del", "add", "add", "ctx", "ctx", "ctx", "ctx"), lines.stream().map(DisplayLine::type).toList());
        assertEquals(List.of("a", "b", "B", "c", "d", "e", "f", "g"), lines.stream().map(DisplayLine::text).toList());
        assertEquals(List.of("N1", "O2", "N2", "N3", "N4", "N5", "N6", "N7"), lines.stream().map(DisplayLine::key).toList());
    }

    @Test
    void wholeFileKeepsOldLineNumbersBehindAChange() {
        List<DisplayLine> lines = whole(SOURCE, PATCH);
        DisplayLine f = lines.get(6);
        assertEquals(6, f.newLine());
        assertEquals(5, f.oldLine()); // one line more was added than removed above
    }

    @Test
    void wholeFileHasNoGapsAndNoOwnLines() {
        List<DisplayLine> lines = whole(SOURCE, PATCH);
        assertTrue(lines.stream().noneMatch(l -> "gap".equals(l.type()) || l.own() || l.refs() != null));
        // lines of the hunk can be commented on, the rest of the file cannot
        assertEquals(List.of(true, true, true, true, true, false, false, false), lines.stream().map(DisplayLine::inDiff).toList());
    }

    @Test
    void removedFileConsistsOfItsDeletedLines() {
        List<DisplayLine> lines = whole("", "@@ -1,2 +0,0 @@\n-a\n-b");
        assertEquals(List.of("del", "del"), lines.stream().map(DisplayLine::type).toList());
        assertEquals(List.of("a", "b"), lines.stream().map(DisplayLine::text).toList());
    }
}
