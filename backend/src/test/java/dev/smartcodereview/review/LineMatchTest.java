package dev.smartcodereview.review;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LineMatchTest {

    @Test
    void pairsUnchangedLinesAroundInsertedOnes() {
        int[] m = LineMatch.match(List.of("int a = 1;", "int b = 2;"), List.of("int a = 1;", "int new = 0;", "int b = 2;"));
        assertArrayEquals(new int[] {0, 2}, m);
    }

    @Test
    void leavesChangedLinesUnpaired() {
        int[] m = LineMatch.match(List.of("foo();", "bar();", "baz();"), List.of("foo();", "bar(1);", "baz();"));
        assertArrayEquals(new int[] {0, -1, 2}, m);
    }

    @Test
    void pairsTrivialLinesOnlyNextToRealOnes() {
        // the brace follows an unchanged call: it stays; the lone brace after a changed line does not
        int[] kept = LineMatch.match(List.of("  run();", "  }"), List.of("  run();", "  }"));
        assertArrayEquals(new int[] {0, 1}, kept);
        int[] lone = LineMatch.match(List.of("  run();", "  }"), List.of("  walk();", "  }"));
        assertArrayEquals(new int[] {-1, -1}, lone);
    }

    @Test
    void keepsOrder() {
        // a line that moved behind another can only be paired once
        int[] m = LineMatch.match(List.of("first();", "second();"), List.of("second();", "first();"));
        assertEquals(1, IntStream.of(m).filter(i -> i >= 0).count());
    }

    @Test
    void handlesLargeFilesThroughUniqueLines() {
        List<String> a = new ArrayList<>();
        for (int i = 0; i < 3000; i++) {
            a.add("line " + i + ";");
        }
        List<String> b = new ArrayList<>(a);
        b.add(1500, "inserted();");
        b.set(10, "changed();");
        assertTrue((long) a.size() * b.size() > LineMatch.EXACT_LIMIT);
        int[] m = LineMatch.match(a, b);
        assertEquals(-1, m[10]);
        assertEquals(1499, m[1499]);
        assertEquals(1501, m[1500]);
        assertEquals(2999, IntStream.of(m).filter(i -> i >= 0).count());
    }
}
