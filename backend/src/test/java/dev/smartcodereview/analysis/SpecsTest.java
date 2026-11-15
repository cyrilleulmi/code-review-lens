package dev.smartcodereview.analysis;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.smartcodereview.diff.PatchParser;
import dev.smartcodereview.model.Model.Analysis;
import dev.smartcodereview.model.Model.DiffFile;
import dev.smartcodereview.model.Model.PullRequestInfo;
import dev.smartcodereview.model.Model.Segment;
import dev.smartcodereview.model.Model.Snapshot;
import dev.smartcodereview.model.Model.SpecEntry;
import dev.smartcodereview.model.Model.SpecFile;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Spec-Diff: test names of changed test files, old against new version. */
class SpecsTest {

    private static final String SPEC_PATH = "src/app/player.service.spec.ts";

    private static final String OLD_SPEC = """
            describe('PlayerService', () => {
              it('creates a player', () => {
                expect(create()).toBeTruthy();
              });

              it('rejects empty names', () => {
                expect(() => create('')).toThrow();
              });

              describe('jersey number', () => {
                it('accepts 1 to 99', () => {
                  expect(valid(5)).toBe(true);
                });

                it('rejects duplicates', () => {
                  expect(valid(7, [7])).toBe(false);
                });
              });

              it('deletes a player', () => {
                expect(remove(1)).toBe(true);
              });
            });
            """;

    private static final String NEW_SPEC = """
            describe('PlayerService', () => {
              it('creates a player', () => {
                expect(create()).toBeTruthy();
              });

              it('rejects blank names', () => {
                expect(() => create('')).toThrow();
              });

              describe('jersey number', () => {
                it('accepts 1 to 99', () => {
                  expect(valid(5)).toBe(true);
                  expect(valid(99)).toBe(true);
                });

                it('rejects 0 and 100', () => {
                  expect(valid(0)).toBe(false);
                });
              });
            });
            """;

    @Test
    void addedRemovedChangedRenamedUnchangedInNestedSuites() throws Exception {
        Analysis analysis = analyse(List.of(modified(SPEC_PATH, OLD_SPEC, NEW_SPEC)),
                Map.of(SPEC_PATH, NEW_SPEC), Map.of(SPEC_PATH, OLD_SPEC));
        SpecFile spec = only(analysis);
        assertTrue(spec.baseAvailable());
        assertEquals("modified", spec.status());
        assertEquals(List.of(
                "suite PlayerService changed 0",
                "test creates a player unchanged 1",
                "test rejects blank names renamed 1",
                "suite jersey number changed 1",
                "test accepts 1 to 99 changed 2",
                "test rejects duplicates removed 2",
                "test rejects 0 and 100 added 2",
                "test deletes a player removed 1"), outline(spec));

        SpecEntry renamed = entry(spec, "rejects blank names");
        assertEquals("rejects empty names", renamed.previousName());
        assertEquals(List.of("PlayerService"), renamed.suites());
        assertEquals(6, renamed.line());
        assertEquals(6, renamed.oldLine());
        assertEquals("PlayerService › rejects blank names", segment(analysis, renamed.segmentId()).symbol());

        SpecEntry added = entry(spec, "rejects 0 and 100");
        assertEquals(List.of("PlayerService", "jersey number"), added.suites());
        assertNull(added.oldLine());
        assertEquals("PlayerService › jersey number › rejects 0 and 100", segment(analysis, added.segmentId()).symbol());
        assertNotNull(entry(spec, "accepts 1 to 99").segmentId());

        SpecEntry removed = entry(spec, "rejects duplicates");
        assertNull(removed.segmentId());
        assertNull(removed.line());
        assertEquals(15, removed.oldLine());
        assertNull(entry(spec, "creates a player").segmentId(), "untouched tests have no segment");
    }

    @Test
    void renamedSuiteKeepsItsUnchangedChildren() throws Exception {
        String before = """
                describe('Player', () => {
                  it('has a name', () => {
                    expect(player.name).toBe('Ann');
                  });
                });
                """;
        String after = before.replace("describe('Player'", "describe('A player'");
        Analysis analysis = analyse(List.of(modified(SPEC_PATH, before, after)), Map.of(SPEC_PATH, after), Map.of(SPEC_PATH, before));
        SpecFile spec = only(analysis);
        assertEquals(List.of("suite A player renamed 0", "test has a name unchanged 1"), outline(spec));
        assertEquals("Player", entry(spec, "A player").previousName());
        assertEquals(List.of("A player"), entry(spec, "has a name").suites());
    }

    @Test
    void renameAcrossSuitesNamesTheOldPathAndPairsInFileOrder() throws Exception {
        String before = """
                it('first', () => {
                  check();
                });

                it('second', () => {
                  check();
                });
                """;
        String after = """
                describe('checks', () => {
                  it('one', () => {
                    check();
                  });

                  it('two', () => {
                    check();
                  });
                });
                """;
        Analysis analysis = analyse(List.of(modified(SPEC_PATH, before, after)), Map.of(SPEC_PATH, after), Map.of(SPEC_PATH, before));
        SpecFile spec = only(analysis);
        assertEquals(List.of("suite checks added 0", "test one renamed 1", "test two renamed 1"), outline(spec));
        assertEquals("first", entry(spec, "one").previousName(), "same body: the first removed pairs with the first added");
        assertEquals("second", entry(spec, "two").previousName());
    }

    @Test
    void junitClassesAndNestedClassesAreSuites() throws Exception {
        String path = "src/test/java/app/PlayerResourceTest.java";
        String before = """
                package app;

                import org.junit.jupiter.api.Nested;
                import org.junit.jupiter.api.Test;

                class PlayerResourceTest {

                    @Test
                    void createsPlayer() {
                        assertEquals(201, post("/players").status());
                    }

                    @Nested
                    class JerseyNumber {

                        @Test
                        void savesJerseyNumber() {
                            assertEquals(200, put("/players/1/jersey", 7).status());
                        }
                    }
                }
                """;
        String after = """
                package app;

                import org.junit.jupiter.api.Nested;
                import org.junit.jupiter.api.Test;

                class PlayerResourceTest {

                    @Test
                    void createsPlayer() {
                        assertEquals(201, post("/players").status());
                    }

                    @Nested
                    class JerseyNumber {

                        @Test
                        void savesJerseyNumber() {
                            assertEquals(200, put("/players/1/jersey", 7).status());
                        }

                        @Test
                        void rejectsDuplicateJerseyNumber() {
                            assertEquals(409, put("/players/2/jersey", 7).status());
                        }
                    }

                    @Nested
                    class Deletion {

                        @Test
                        void deletesPlayer() {
                            assertEquals(204, delete("/players/1").status());
                        }
                    }
                }
                """;
        Analysis analysis = analyse(List.of(modified(path, before, after)), Map.of(path, after), Map.of(path, before));
        SpecFile spec = only(analysis);
        assertEquals(List.of(
                "suite PlayerResourceTest changed 0",
                "test createsPlayer unchanged 1",
                "suite JerseyNumber changed 1",
                "test savesJerseyNumber unchanged 2",
                "test rejectsDuplicateJerseyNumber added 2",
                "suite Deletion added 1",
                "test deletesPlayer added 2"), outline(spec));
        assertEquals(List.of("PlayerResourceTest", "JerseyNumber"), entry(spec, "rejectsDuplicateJerseyNumber").suites());
    }

    @Test
    void removedFileListsAllEntriesAsRemoved() throws Exception {
        DiffFile removed = removed(SPEC_PATH, OLD_SPEC);
        SpecFile spec = only(analyse(List.of(removed), Map.of(), Map.of(SPEC_PATH, OLD_SPEC)));
        assertTrue(spec.baseAvailable());
        assertEquals(List.of(
                "suite PlayerService removed 0",
                "test creates a player removed 1",
                "test rejects empty names removed 1",
                "suite jersey number removed 1",
                "test accepts 1 to 99 removed 2",
                "test rejects duplicates removed 2",
                "test deletes a player removed 1"), outline(spec));

        SpecFile withoutBase = only(analyse(List.of(removed), Map.of(), Map.of()));
        assertFalse(withoutBase.baseAvailable());
        assertTrue(withoutBase.entries().isEmpty());
    }

    @Test
    void withoutBaseOnlyTheNewSideDerivedFromTheDiff() throws Exception {
        Analysis analysis = analyse(List.of(modified(SPEC_PATH, OLD_SPEC, NEW_SPEC)), Map.of(SPEC_PATH, NEW_SPEC), Map.of());
        SpecFile spec = only(analysis);
        assertFalse(spec.baseAvailable());
        assertEquals(List.of(
                "suite PlayerService changed 0",
                "test creates a player unchanged 1",
                "test rejects blank names changed 1",
                "suite jersey number changed 1",
                "test accepts 1 to 99 changed 2",
                "test rejects 0 and 100 added 2"), outline(spec));
    }

    @Test
    void addedFileAndRenamedFileWithoutTestsChanges() throws Exception {
        SpecFile added = only(analyse(List.of(added(SPEC_PATH, NEW_SPEC)), Map.of(SPEC_PATH, NEW_SPEC), Map.of()));
        assertTrue(added.baseAvailable());
        assertTrue(added.entries().stream().allMatch(e -> e.status().equals("added")));

        String oldPath = "src/app/old/player.service.spec.ts";
        DiffFile moved = new DiffFile(SPEC_PATH, oldPath, "renamed", 0, 0, Languages.of(SPEC_PATH), false, List.of());
        SpecFile renamed = only(analyse(List.of(moved), Map.of(SPEC_PATH, OLD_SPEC), Map.of(oldPath, OLD_SPEC)));
        assertEquals(oldPath, renamed.previousPath());
        assertTrue(renamed.entries().stream().allMatch(e -> e.status().equals("unchanged")), outline(renamed).toString());
    }

    @Test
    void nonTestFilesHaveNoSpec() throws Exception {
        String path = "src/app/player.service.ts";
        String code = "export function create() {\n  return {};\n}\n";
        Analysis analysis = analyse(List.of(added(path, code)), Map.of(path, code), Map.of());
        assertTrue(analysis.specs().isEmpty());
    }

    // ------------------------------------------------------------------ helpers

    private static List<String> outline(SpecFile spec) {
        return spec.entries().stream().map(e -> e.kind() + " " + e.name() + " " + e.status() + " " + e.depth()).toList();
    }

    static SpecEntry entry(SpecFile spec, String name) {
        return spec.entries().stream().filter(e -> e.name().equals(name)).findFirst().orElseThrow(() -> new AssertionError(name));
    }

    static SpecFile only(Analysis analysis) {
        assertNotNull(analysis.specs());
        assertEquals(1, analysis.specs().size());
        return analysis.specs().getFirst();
    }

    private static Segment segment(Analysis analysis, String id) {
        assertNotNull(id);
        return analysis.segments().stream().filter(s -> s.id().equals(id)).findFirst().orElseThrow();
    }

    static Analysis analyse(List<DiffFile> files, Map<String, String> sources, Map<String, String> base) throws Exception {
        Snapshot snapshot = new Snapshot(1, "now", info(), files);
        return new Analyzer(defaultRules()).analyze(snapshot, new HashMap<>(sources), null, base);
    }

    private static String[] lines(String text) {
        if (text.isEmpty()) {
            return new String[0];
        }
        String[] l = text.split("\n", -1);
        return text.endsWith("\n") ? java.util.Arrays.copyOf(l, l.length - 1) : l;
    }

    /** A real line diff (longest common subsequence) as one hunk with full context. */
    static DiffFile modified(String path, String before, String after) {
        String[] a = lines(before);
        String[] b = lines(after);
        int[][] lcs = new int[a.length + 1][b.length + 1];
        for (int i = a.length - 1; i >= 0; i--) {
            for (int j = b.length - 1; j >= 0; j--) {
                lcs[i][j] = a[i].equals(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
        List<String> out = new ArrayList<>();
        int i = 0, j = 0, adds = 0, dels = 0;
        while (i < a.length || j < b.length) {
            if (i < a.length && j < b.length && a[i].equals(b[j])) {
                out.add(" " + a[i++]);
                j++;
            } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
                out.add("-" + a[i++]);
                dels++;
            } else {
                out.add("+" + b[j++]);
                adds++;
            }
        }
        String patch = "@@ -1," + a.length + " +1," + b.length + " @@\n" + String.join("\n", out);
        return new DiffFile(path, null, "modified", adds, dels, Languages.of(path), false, PatchParser.parse(patch));
    }

    static DiffFile added(String path, String content) {
        String[] l = lines(content);
        StringBuilder patch = new StringBuilder("@@ -0,0 +1," + l.length + " @@\n");
        for (String s : l) {
            patch.append('+').append(s).append('\n');
        }
        return new DiffFile(path, null, "added", l.length, 0, Languages.of(path), false, PatchParser.parse(patch.toString()));
    }

    static DiffFile removed(String path, String content) {
        String[] l = lines(content);
        StringBuilder patch = new StringBuilder("@@ -1," + l.length + " +0,0 @@\n");
        for (String s : l) {
            patch.append('-').append(s).append('\n');
        }
        return new DiffFile(path, null, "removed", 0, l.length, Languages.of(path), false, PatchParser.parse(patch.toString()));
    }

    private static PullRequestInfo info() {
        return new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open", "main", "feature",
                "base", "head", "", "", 0, 0, 0, null);
    }

    private static Rules defaultRules() throws Exception {
        try (InputStream in = SpecsTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return Rules.parse(new ObjectMapper().readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8)), "test");
        }
    }
}
