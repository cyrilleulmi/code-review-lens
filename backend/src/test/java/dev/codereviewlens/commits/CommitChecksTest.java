package dev.codereviewlens.commits;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codereviewlens.analysis.Rules;
import dev.codereviewlens.model.Model;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.CodeCoverage;
import dev.codereviewlens.model.Model.Commit;
import dev.codereviewlens.model.Model.CommitFinding;
import dev.codereviewlens.model.Model.Commits;
import dev.codereviewlens.model.Model.Segment;
import dev.codereviewlens.model.Model.TestInfo;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CommitChecksTest {

    private static final String RESOURCE = "src/main/java/app/PlayerResource.java";
    private static final String VIEW = "src/app/player-view.ts";
    private static final String TEST = "src/test/java/app/JerseyNumberTest.java";

    /** A test class with one test: declaration line 5, assertion line 7, body lines 5-8. */
    private static final String TEST_SOURCE = """
            package app;

            class JerseyNumberTest {
                @Test
                void rejectsNumbersOutsideTheRange() {
                    var e = assertThrows(BadRequest.class, () -> resource.validate(100));
                    assertEquals("Number must be 1-99", e.getMessage());
                }
            }
            """;

    // ------------------------------------------------------------------ expectation adjusted later

    @Test
    void expectationChangedInALaterTestOnlyCommitIsAWarning() {
        Commits commits = commits(
                List.of(commit("c1", "Validate the jersey number", RESOURCE),
                        commit("c2", "More jersey number tests", TEST),
                        commit("c3", "fix tests", TEST)),
                Map.of(RESOURCE, keys("c1", "N10", "N11"),
                        TEST, keys("c2", "N3", "N4", "N5", "N6", "N8", "N9", "N7:c3")));
        Analysis analysis = analysis(
                List.of(segment("r1", RESOURCE, "PlayerResource.validate", 9, 12, "N10", "N11"),
                        segment("t1", TEST, "JerseyNumberTest.rejectsNumbersOutsideTheRange", 4, 8, "N4", "N5", "N6", "N7", "N8")),
                List.of(test("t1", TEST)),
                List.of(coverage("r1", "indirect", List.of(), List.of("t1"))));

        List<CommitFinding> findings = CommitChecks.find(rules(), commits, analysis, Map.of(TEST, TEST_SOURCE));

        assertEquals(1, findings.size(), findings.toString());
        CommitFinding f = findings.getFirst();
        assertEquals(CommitChecks.EXPECTATION_LATER, f.kind());
        assertEquals(CommitChecks.WARN, f.level());
        assertEquals("c3", f.sha());
        assertEquals("fix tests", f.title());
        assertEquals(TEST, f.path());
        assertEquals("N7", f.lineKey());
        assertEquals("t1", f.testSegmentId());
        assertEquals("t1", f.segmentId());
        assertTrue(f.detail().contains("nur Tests"), f.detail());
        assertTrue(f.detail().contains("Number must be 1-99"), f.detail());
    }

    @Test
    void expectationChangedTogetherWithCodeIsOnlyInformation() {
        Commits commits = commits(
                List.of(commit("c1", "Jersey number tests", TEST),
                        commit("c2", "Allow numbers up to 99", RESOURCE, TEST)),
                Map.of(RESOURCE, keys("c2", "N10"),
                        TEST, keys("c1", "N3", "N4", "N5", "N6", "N8", "N9", "N7:c2")));
        Analysis analysis = analysis(
                List.of(segment("r1", RESOURCE, "PlayerResource.validate", 9, 12, "N10"),
                        segment("t1", TEST, "JerseyNumberTest.rejectsNumbersOutsideTheRange", 4, 8, "N4", "N5", "N6", "N7", "N8")),
                List.of(test("t1", TEST)), List.of());

        List<CommitFinding> findings = CommitChecks.find(rules(), commits, analysis, Map.of(TEST, TEST_SOURCE));

        assertEquals(1, findings.size(), findings.toString());
        assertEquals(CommitChecks.EXPECTATION_LATER, findings.getFirst().kind());
        assertEquals(CommitChecks.INFO, findings.getFirst().level());
    }

    @Test
    void testOlderThanThePullRequestIsNoExpectationFinding() {
        // only the assertion line is changed: the declaration line has no commit (base version)
        Commits commits = commits(List.of(commit("c1", "Adjust tests", TEST)), Map.of(TEST, keys("c1", "N7")));
        Analysis analysis = analysis(
                List.of(segment("t1", TEST, "JerseyNumberTest.rejectsNumbersOutsideTheRange", 4, 8, "N7")),
                List.of(test("t1", TEST)), List.of());

        assertEquals(List.of(), CommitChecks.find(rules(), commits, analysis, Map.of(TEST, TEST_SOURCE)));
    }

    // ------------------------------------------------------------------ fix without test

    @Test
    void fixCommitWithoutTestIsAWarning() {
        Commits commits = commits(
                List.of(commit("c1", "Jersey number with tests", RESOURCE, TEST),
                        commit("c2", "Fix jersey number rounding", RESOURCE, VIEW)),
                Map.of(RESOURCE, keys("c1", "N10", "N12:c2"), VIEW, keys("c2", "N20")));
        Analysis analysis = analysis(
                List.of(segment("r1", RESOURCE, "PlayerResource.validate", 9, 14, "N10", "N12"),
                        segment("v1", VIEW, "PlayerView.save", 18, 22, "N20")),
                List.of(), List.of());

        List<CommitFinding> findings = CommitChecks.find(rules(), commits, analysis, Map.of());

        assertEquals(1, findings.size(), findings.toString());
        CommitFinding f = findings.getFirst();
        assertEquals(CommitChecks.FIX_WITHOUT_TEST, f.kind());
        assertEquals(CommitChecks.WARN, f.level());
        assertEquals("c2", f.sha());
        assertEquals(RESOURCE, f.path());
        assertEquals("N12", f.lineKey());
        assertEquals("r1", f.segmentId());
        assertNull(f.testSegmentId());
        assertTrue(f.detail().contains("PlayerResource.java, player-view.ts"), f.detail());
    }

    @Test
    void fixWithItsTestAndTestAdjustmentsAreNoFixWithoutTest() {
        Commits commits = commits(
                List.of(commit("c1", "Fix rounding", RESOURCE, TEST),
                        commit("c2", "fix tests", RESOURCE),
                        commit("c3", "Bugfix: build script", "backend/build.gradle.kts"),
                        commit("c4", "Prefix the label", VIEW)),
                Map.of());
        Analysis analysis = analysis(List.of(), List.of(), List.of());

        List<CommitFinding> findings = CommitChecks.find(rules(), commits, analysis, Map.of());

        assertEquals(List.of(), findings);
    }

    @Test
    void titlePatterns() {
        Rules.CommitCheckRules r = rules().commitChecks;
        assertTrue(r.isFix("Fix jersey number rounding"));
        assertTrue(r.isFix("fixes #12"));
        assertTrue(r.isFix("Hotfix for the login"));
        assertTrue(r.isFix("Rundung korrigiert"));
        assertTrue(r.isFix("Behebe Absturz beim Speichern"));
        assertFalse(r.isFix("Prefix the label"));
        assertFalse(r.isFix("fixup! Add jersey number"));
        assertFalse(r.isFix("Debug output"));
        assertFalse(r.isFix("fix tests"));
        assertTrue(r.isTestAdjust("fix tests"));
        assertTrue(r.isTestAdjust("Adjust player test expectations"));
        assertTrue(r.isTestAdjust("make tests pass"));
        assertTrue(r.isTestAdjust("Tests anpassen"));
        assertTrue(r.isTestAdjust("Tests grün"));
        assertFalse(r.isTestAdjust("Fix jersey number rounding"));
    }

    // ------------------------------------------------------------------ logic without test

    @Test
    void logicCommitFollowedByATestCommitIsNoFinding() {
        Commits commits = commits(
                List.of(commit("c1", "Clear jersey number", RESOURCE, VIEW),
                        commit("c2", "Rework player tests", TEST)),
                Map.of(RESOURCE, keys("c1", "N10", "N11"), VIEW, keys("c1", "N20"),
                        TEST, keys("c2", "N4", "N5", "N6", "N7", "N8")));
        Analysis analysis = analysis(
                List.of(segment("r1", RESOURCE, "PlayerResource.clear", 9, 12, "N10", "N11"),
                        segment("v1", VIEW, "PlayerView.clear", 18, 22, "N20"),
                        segment("t1", TEST, "JerseyNumberTest.clears", 4, 8, "N4", "N5", "N6", "N7", "N8")),
                List.of(test("t1", TEST)),
                List.of(coverage("v1", "none", List.of(), List.of()),
                        coverage("r1", "direct", List.of("t1"), List.of())));

        List<CommitFinding> findings = CommitChecks.find(rules(), commits, analysis, Map.of(TEST, TEST_SOURCE));

        // the backend part got its test later; the frontend part never did
        assertEquals(1, findings.size(), findings.toString());
        CommitFinding f = findings.getFirst();
        assertEquals(CommitChecks.LOGIC_WITHOUT_TEST, f.kind());
        assertEquals(CommitChecks.INFO, f.level());
        assertEquals("c1", f.sha());
        assertEquals("v1", f.segmentId());
        assertEquals("N20", f.lineKey());
        assertTrue(f.detail().startsWith("PlayerView.clear geändert in c1"), f.detail());
    }

    @Test
    void logicChangedAfterItsTestsIsAFindingButTestFirstIsNot() {
        Commits commits = commits(
                List.of(commit("c1", "Test for clearing", TEST),
                        commit("c2", "Clear jersey number", RESOURCE),
                        commit("c3", "Only a coach may clear", RESOURCE)),
                Map.of(RESOURCE, keys("c2", "N10", "N12:c3"), TEST, keys("c1", "N4", "N5", "N6", "N7", "N8")));
        Analysis analysis = analysis(
                List.of(segment("r1", RESOURCE, "PlayerResource.clear", 9, 13, "N10", "N12"),
                        segment("t1", TEST, "JerseyNumberTest.clears", 4, 8, "N4", "N5", "N6", "N7", "N8")),
                List.of(test("t1", TEST)),
                List.of(coverage("r1", "direct", List.of("t1"), List.of())));

        List<CommitFinding> findings = CommitChecks.find(rules(), commits, analysis, Map.of(TEST, TEST_SOURCE));

        // c2 implements what the test of c1 already expects (test first); c3 changes it again without a test
        assertEquals(1, findings.size(), findings.toString());
        assertEquals("c3", findings.getFirst().sha());
        assertEquals("N12", findings.getFirst().lineKey());
        assertEquals(CommitChecks.LOGIC_WITHOUT_TEST, findings.getFirst().kind());
    }

    // ------------------------------------------------------------------ skipped commits

    @Test
    void mergeCommitsSideBranchesAndCommitsWithoutDiffAreSkipped() {
        Commit base = commit("c1", "Start", TEST);
        Commit side = new Commit("s1", "Fix rounding on a branch", "", "dev", null, null, null, null, List.of("c1"), 1, 1,
                List.of(RESOURCE));
        Commit merge = new Commit("m1", "Merge branch 'fix' - fix rounding", "", "dev", null, null, null, null,
                List.of("c1", "s1"), 1, 1, List.of(RESOURCE));
        Commit noDiff = new Commit("c2", "Fix the view", "", "dev", null, null, null, null, List.of("m1"), 0, 0, List.of());
        Commits commits = new Commits(1, "c2", null, List.of(base, side, merge, noDiff),
                Map.of(RESOURCE, keys("m1", "N10")), Map.of("s1", "m1"), null);
        Analysis analysis = analysis(
                List.of(segment("r1", RESOURCE, "PlayerResource.round", 9, 12, "N10")),
                List.of(), List.of(coverage("r1", "none", List.of(), List.of())));

        assertEquals(List.of(), CommitChecks.find(rules(), commits, analysis, Map.of()));
    }

    // ------------------------------------------------------------------ helpers

    private static Commit commit(String sha, String title, String... files) {
        return new Commit(sha, title, title, "dev", null, null, null, null, List.of(), 1, 1, List.of(files));
    }

    /** Commits in the given order (parents chained), with lines path -> key -> sha. */
    private static Commits commits(List<Commit> list, Map<String, Map<String, String>> lines) {
        List<Commit> chained = new ArrayList<>();
        String parent = null;
        for (Commit c : list) {
            chained.add(new Commit(c.sha(), c.title(), c.message(), c.author(), null, null, null, null,
                    parent == null ? List.of() : List.of(parent), c.additions(), c.deletions(), c.files()));
            parent = c.sha();
        }
        return new Commits(1, parent, null, chained, lines, Map.of(), null);
    }

    /** Line keys made by sha; "N7:c3" = this key by another commit. */
    private static Map<String, String> keys(String sha, String... keys) {
        Map<String, String> result = new TreeMap<>();
        for (String k : keys) {
            int colon = k.indexOf(':');
            result.put(colon < 0 ? k : k.substring(0, colon), colon < 0 ? sha : k.substring(colon + 1));
        }
        return result;
    }

    private static Segment segment(String id, String path, String symbol, int start, int end, String... keys) {
        return new Segment(id, path, "java", "symbol", symbol, path.contains("/test/") ? "test" : "method", start, end,
                path.contains("/test/") ? "tests" : "logic", null, null, null, List.of(keys), List.of(), List.of(),
                List.of(), null, false);
    }

    private static TestInfo test(String id, String path) {
        return new TestInfo(id, id, path, List.of(), List.of(), null);
    }

    private static CodeCoverage coverage(String id, String status, List<String> direct, List<String> indirect) {
        return new CodeCoverage(id, status, direct, indirect, 0, 1, 1, List.of(), List.of());
    }

    private static Analysis analysis(List<Segment> segments, List<TestInfo> tests, List<CodeCoverage> coverage) {
        Map<String, Segment> unique = new LinkedHashMap<>();
        segments.forEach(s -> unique.put(s.id(), s));
        return new Analysis(Model.SCHEMA_VERSION, null, null, null, List.copyOf(unique.values()), List.of(), List.of(),
                tests, null, List.of(), List.of(), coverage, List.of(), List.of(), List.of(), null, List.of(), List.of(),
                List.of(), List.of());
    }

    private static Rules rules() {
        try (InputStream in = CommitChecksTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(in), "test");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
