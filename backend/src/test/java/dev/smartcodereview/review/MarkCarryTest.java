package dev.smartcodereview.review;

import dev.smartcodereview.diff.PatchParser;
import dev.smartcodereview.model.Model.Analysis;
import dev.smartcodereview.model.Model.Category;
import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.Flow;
import dev.smartcodereview.model.Model.FlowStep;
import dev.smartcodereview.model.Model.Group;
import dev.smartcodereview.model.Model.PullRequestInfo;
import dev.smartcodereview.model.Model.ReloadInfo;
import dev.smartcodereview.model.Model.ReviewState;
import dev.smartcodereview.model.Model.Segment;
import dev.smartcodereview.model.Model.Snapshot;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class MarkCarryTest {

    private static final String PATH = "src/A.java";

    /** Reviewed: foo() replaces old(). */
    private static final String BEFORE = """
            @@ -1,4 +1,5 @@
             class A {
            -  void old() {}
            +  void foo() {
            +    bar();
            +  }
             }
            """;

    /** A new commit adds an import above and changes bar() to baz(). */
    private static final String AFTER = """
            @@ -1,4 +1,7 @@
            +import x.Y;
            +
             class A {
            -  void old() {}
            +  void foo() {
            +    baz();
            +  }
             }
            """;

    @Test
    void marksMoveWithUnchangedLinesAndDropOnChangedOnes() {
        ReviewState state = state(Map.of(PATH, List.of("N2", "N3", "N4", "O2")), Map.of(), null);
        ReviewState next = MarkCarry.carry(state, snapshot("h1", BEFORE), null, snapshot("h2", AFTER), null, "now");

        // foo() moved from N2 to N4, the deleted old() keeps O2; bar() changed, its closing brace goes with it
        assertEquals(Map.of(PATH, List.of("N4", "O2")), next.ok());
        assertEquals("h2", next.headSha());
        ReloadInfo r = next.reload();
        assertEquals("h1", r.fromHeadSha());
        assertEquals(2, r.kept());
        assertEquals(2, r.dropped());
        assertEquals(Map.of(PATH, List.of("N1", "N2", "N5", "N6")), r.newLines());
        assertEquals("carry", next.log().getLast().action());
    }

    @Test
    void stillOpenNewLinesStayNewOverSeveralReloads() {
        ReloadInfo earlier = new ReloadInfo("h0", "h1", "then", 0, 0, Map.of(PATH, List.of("N2", "N3")));
        // foo() (N2) was reviewed since, bar() (N3) not: only bar() would stay new - but it changes now anyway
        ReviewState state = state(Map.of(PATH, List.of("N2")), Map.of(), earlier);
        ReviewState next = MarkCarry.carry(state, snapshot("h1", BEFORE), null, snapshot("h1b", BEFORE.replace("-  void old() {}\n", "")), null, "now");
        assertEquals(Map.of(PATH, List.of("N3")), next.reload().newLines());
    }

    @Test
    void marksAtAFlowFollowTheFlowByItsEntryPoint() {
        // before: the reviewed flow is flow-1; after a new flow sorts first, it is flow-2
        Analysis before = analysis(List.of(flow("flow-1", "s1")), List.of(segment("s1", PATH, "A.foo")));
        Analysis after = analysis(List.of(flow("flow-1", "s9"), flow("flow-2", "s1")),
                List.of(segment("s1", PATH, "A.foo"), segment("s9", "src/B.java", "B.run")));
        ReviewState state = state(Map.of(), Map.of("flows/flow-1", Map.of(PATH, List.of("N2"))), null);

        ReviewState next = MarkCarry.carry(state, snapshot("h1", BEFORE), before, snapshot("h2", AFTER), after, "now");

        assertEquals(Map.of("flows/flow-2", Map.of(PATH, List.of("N4"))), next.okAt());
        assertEquals(1, next.reload().kept());
    }

    @Test
    void sameSnapshotKeepsEverything() {
        ReviewState state = state(Map.of(PATH, List.of("N2", "N3", "N4", "O2")), Map.of(), null);
        ReviewState next = MarkCarry.carry(state, snapshot("h1", BEFORE), null, snapshot("h1", BEFORE), null, "now");
        assertEquals(state.ok(), next.ok());
        assertEquals(0, next.reload().dropped());
        assertEquals(Map.of(), next.reload().newLines());
    }

    @Test
    void aRenamedFileKeepsItsMarks() {
        ReviewState state = state(Map.of(PATH, List.of("N2")), Map.of(), null);
        Snapshot before = new Snapshot(1, "t", info("h1"), List.of(file(PATH, "src/Old.java", BEFORE)));
        Snapshot after = new Snapshot(1, "t", info("h2"), List.of(file("src/A2.java", "src/Old.java", BEFORE)));
        ReviewState next = MarkCarry.carry(state, before, null, after, null, "now");
        assertEquals(Map.of("src/A2.java", List.of("N2")), next.ok());
        assertNull(next.ok().get(PATH));
    }

    // ---------------------------------------------------------------- helpers

    private static ReviewState state(Map<String, List<String>> ok, Map<String, Map<String, List<String>>> okAt, ReloadInfo reload) {
        return new ReviewState(1, "github/o/r/1", "h1", ok, List.of(), okAt, reload);
    }

    private static Snapshot snapshot(String head, String patch) {
        return new Snapshot(1, "t", info(head), List.of(file(PATH, null, patch)));
    }

    private static DiffFile file(String path, String previousPath, String patch) {
        return new DiffFile(path, previousPath, previousPath == null ? "modified" : "renamed", 0, 0, "java", false,
                PatchParser.parse(patch));
    }

    private static PullRequestInfo info(String head) {
        return new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open", "main", "feature",
                "base", head, "", "", 0, 0, 0, null);
    }

    private static Segment segment(String id, String path, String symbol) {
        return new Segment(id, path, "java", "symbol", symbol, "method", 1, 5, null, null, null, null,
                List.of(), List.of(), List.of(), List.of(), null, false);
    }

    private static Flow flow(String id, String entry) {
        return new Flow(id, "Flow " + id, List.of(new FlowStep(entry, 0, 0, null)), List.of());
    }

    private static Analysis analysis(List<Flow> flows, List<Segment> segments) {
        List<Group> groups = flows.stream().map(f -> new Group("flows/" + f.id(), f.title(), null, f.id(), List.of())).toList();
        return new Analysis(1, "t", "h", "r", segments, List.of(new Category("flows", "Datenflüsse", null, null, groups,
                null, null, "flow", "builtin")), flows, List.of(), null, List.of(), List.of(),
                null, null, null, null, null, null, null, null, null);
    }
}
