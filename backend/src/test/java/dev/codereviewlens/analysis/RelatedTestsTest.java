package dev.codereviewlens.analysis;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.codereviewlens.diff.PatchParser;
import dev.codereviewlens.model.Model.Analysis;
import dev.codereviewlens.model.Model.CodeCoverage;
import dev.codereviewlens.model.Model.DiffFile;
import dev.codereviewlens.model.Model.ExistingTest;
import dev.codereviewlens.model.Model.PullRequestInfo;
import dev.codereviewlens.model.Model.RelatedTestFile;
import dev.codereviewlens.model.Model.Segment;
import dev.codereviewlens.model.Model.Snapshot;
import dev.codereviewlens.model.Model.TestCoverage;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Bestehende Tests: selecting existing test files by name, and linking their test cases to the changed code. */
class RelatedTestsTest {

    private static final String JAVA = "backend/src/main/java/app/player/PlayerResource.java";

    @Test
    void selectsMirroredTestsThenSameNameElsewhereThenPrefix() throws Exception {
        List<String> repo = List.of(
                JAVA,
                "backend/src/test/java/app/player/PlayerResourceTest.java",          // mirror
                "backend/src/test/java/app/player/PlayerResourceSecurityTest.java",  // prefix
                "backend/src/test/java/app/player/PlayerResourcesTest.java",         // another unit
                "backend/src/test/java/app/player/PlayerRepositoryTest.java",        // another unit
                "legacy/src/test/java/app/player/PlayerResourceTest.java",           // same name, but a mirror exists
                "frontend/src/app/auth/current-user.service.ts",
                "frontend/src/app/auth/current-user.service.spec.ts",                // mirror = same directory
                "frontend/src/app/util/format.ts",
                "frontend/src/test/unit/format.spec.ts",                             // nearest of that name
                "tools/scripts/format.spec.ts",                                      // farther away
                "pkg/store/player.go",
                "pkg/store/player_test.go",                                          // Go: same directory
                "pkg/store/player_list_test.go",                                     // another unit, not a prefix
                "frontend/src/app/auth/current-user.html");
        Snapshot snapshot = snapshot(
                changed(JAVA), changed("frontend/src/app/auth/current-user.service.ts"),
                changed("frontend/src/app/util/format.ts"), changed("pkg/store/player.go"));

        RelatedTests.Selection s = RelatedTests.select(defaultRules(), snapshot.files(), repo);

        assertEquals(List.of(
                        "backend/src/test/java/app/player/PlayerResourceTest.java",
                        "frontend/src/app/auth/current-user.service.spec.ts",
                        "pkg/store/player_test.go",
                        "frontend/src/test/unit/format.spec.ts",
                        "backend/src/test/java/app/player/PlayerResourceSecurityTest.java"),
                s.files().stream().map(RelatedTestFile::path).toList(), "mirror, then name, then prefix; each by source path");
        assertEquals(List.of("mirror", "mirror", "mirror", "name", "prefix"), s.files().stream().map(RelatedTestFile::reason).toList());
        assertEquals(List.of(JAVA), s.files().getFirst().sources());
        assertEquals(List.of("frontend/src/app/util/format.ts"), s.files().get(3).sources());
        assertEquals(5, s.candidates());
        assertFalse(s.truncated());
        assertTrue(s.files().stream().noneMatch(RelatedTestFile::loaded), "the caller loads them");
    }

    @Test
    void mirrorsAreConfigurableAndMatchWholeSegments() {
        List<Rules.Mirror> mirrors = List.of(new Rules.Mirror("src/main/", "src/test/"), new Rules.Mirror("src/", "test/"));
        assertEquals(List.of("a/src/main/java/x", "a/src/test/java/x", "a/test/main/java/x"),
                List.copyOf(RelatedTests.mirroredDirs("a/src/main/java/x", mirrors)));
        assertEquals(List.of("mysrc/app"), List.copyOf(RelatedTests.mirroredDirs("mysrc/app", mirrors)), "no partial segment");
        assertEquals(List.of("src/app", "test/app"), List.copyOf(RelatedTests.mirroredDirs("src/app", mirrors)));
        assertTrue(RelatedTests.startsWithWord("PlayerResourceSecurity", "PlayerResource"));
        assertTrue(RelatedTests.startsWithWord("player-list.component", "player-list"));
        assertFalse(RelatedTests.startsWithWord("player-list", "player"));
        assertFalse(RelatedTests.startsWithWord("PlayerResources", "PlayerResource"));
        assertFalse(RelatedTests.startsWithWord("PlayerResource", "PlayerResource"));
    }

    @Test
    void testFilesOfThePullRequestRemovedAndTestSourcesAreLeftOut() throws Exception {
        List<String> repo = List.of(
                "src/app/player.service.ts", "src/app/player.service.spec.ts",
                "src/app/team.service.ts", "src/app/team.service.spec.ts",
                "src/app/test-utils.spec.ts", "src/app/test-utils.ts");
        Snapshot snapshot = snapshot(
                changed("src/app/player.service.ts"), changed("src/app/player.service.spec.ts"), // test changed in the PR
                new DiffFile("src/app/team.service.ts", null, "removed", 0, 1, "typescript", false, List.of()),
                changed("src/app/test-utils.spec.ts"));
        RelatedTests.Selection s = RelatedTests.select(defaultRules(), snapshot.files(), repo);
        assertTrue(s.files().isEmpty(), "changed test excluded, removed file and test files are no sources: " + s.files());
        assertEquals(0, s.candidates());
    }

    @Test
    void limitCutsTheSelectionAndSaysSo() throws Exception {
        JsonNode root = new ObjectMapper().readTree(rulesJson());
        ((ObjectNode) root.path("relatedTests")).put("limit", 2);
        Rules rules = Rules.parse(root, "test");
        assertEquals(2, rules.relatedTests.limit());
        assertFalse(rules.relatedTests.mirrors().isEmpty(), "missing keys come from the built-in rules");
        List<String> repo = List.of("src/a.spec.ts", "src/b.spec.ts", "src/c.spec.ts", "src/a.extra.spec.ts");
        Snapshot snapshot = snapshot(changed("src/c.ts"), changed("src/a.ts"), changed("src/b.ts"));

        RelatedTests.Selection s = RelatedTests.select(rules, snapshot.files(), repo);
        assertEquals(List.of("src/a.spec.ts", "src/b.spec.ts"), s.files().stream().map(RelatedTestFile::path).toList());
        assertEquals(4, s.candidates());
        assertTrue(s.truncated());
    }

    // ------------------------------------------------------------------ linking (analyzer)

    private static final String SERVICE = """
            export class PlayerService {
              validateNumber(n: number): void {
                if (n > 99) {
                  throw new Error('too big');
                }
              }

              updateNumber(n: number): void {
                this.validateNumber(n);
                this.store.save(n);
              }

              createPlayer(n: number): void {
                if (n > 0) {
                  this.store.add(n);
                }
              }

              resetNumbers(all: boolean): void {
                if (all) {
                  this.store.clear();
                }
              }
            }
            """;
    private static final String EXISTING_SPEC = """
            import { PlayerService } from './player.service';

            describe('PlayerService', () => {
              function makeService(): PlayerService {
                return new PlayerService();
              }

              it('updates the number', () => {
                const service = makeService();
                service.updateNumber(7);
                expect(service).toBeTruthy();
              });

              it('creates through a helper', () => {
                createVia(makeService());
              });

              it('does something else', () => {
                expect(1).toBe(1);
              });
            });

            function createVia(s: PlayerService) {
              s.createPlayer(3);
            }
            """;
    private static final String CHANGED_SPEC = """
            import { PlayerService } from './player.service';

            describe('PlayerService (new)', () => {
              it('rejects 100', () => {
                expect(() => new PlayerService().updateNumber(100)).toThrow();
              });
            });
            """;
    private static final String SERVICE_PATH = "src/app/player.service.ts";
    private static final String SPEC_PATH = "src/app/player.service.spec.ts";
    private static final String NEW_SPEC_PATH = "src/app/player.service.new.spec.ts";

    @Test
    void linksUnchangedTestCasesToChangedCodeDirectlyAndIndirectly() throws Exception {
        Analysis a = analyse(false);
        Segment validate = segment(a, "PlayerService.validateNumber");
        Segment update = segment(a, "PlayerService.updateNumber");
        Segment create = segment(a, "PlayerService.createPlayer");
        Segment reset = segment(a, "PlayerService.resetNumbers");
        assertTrue(a.segments().stream().noneMatch(s -> s.path().equals(SPEC_PATH)), "existing tests are no segments");

        assertEquals(2, a.existingTests().size(), "only test cases that reach changed code: " + a.existingTests());
        ExistingTest updates = a.existingTests().get(0);
        assertEquals("e1", updates.id());
        assertEquals(SPEC_PATH, updates.path());
        assertEquals("PlayerService › updates the number", updates.name());
        assertEquals(8, updates.line());
        assertEquals("mirror", updates.reason());
        Map<String, TestCoverage> covers = new HashMap<>();
        updates.covers().forEach(c -> covers.put(c.segmentId(), c));
        assertTrue(covers.get(update.id()).direct());
        assertEquals(10, covers.get(update.id()).line(), "call site in the test");
        assertFalse(covers.get(validate.id()).direct());
        assertEquals(update.id(), covers.get(validate.id()).via());
        assertNotNull(updates.profile());
        assertEquals(List.of("updateNumber"), updates.profile().targets());

        ExistingTest viaHelper = a.existingTests().get(1);
        assertEquals("e2", viaHelper.id());
        assertEquals(List.of(create.id()), viaHelper.covers().stream().map(TestCoverage::segmentId).toList());
        assertTrue(viaHelper.covers().getFirst().direct(), "helpers of the test file are transparent");

        Map<String, CodeCoverage> byId = new HashMap<>();
        a.coverage().forEach(c -> byId.put(c.segmentId(), c));
        assertEquals("existing", byId.get(update.id()).status());
        assertEquals(List.of("e1"), byId.get(update.id()).existingTests());
        assertEquals("existing", byId.get(validate.id()).status());
        assertEquals("existing", byId.get(create.id()).status());
        assertEquals(List.of("e2"), byId.get(create.id()).existingTests());
        assertEquals("none", byId.get(reset.id()).status());
        assertEquals(reset.id(), a.coverage().getFirst().segmentId(), "none before existing");

        assertNotNull(a.relatedTests());
        assertEquals(1, a.relatedTests().files().size());
    }

    @Test
    void changedTestsWinTheStatusButExistingOnesAreStillListed() throws Exception {
        Analysis a = analyse(true);
        Segment update = segment(a, "PlayerService.updateNumber");
        Segment validate = segment(a, "PlayerService.validateNumber");
        Segment create = segment(a, "PlayerService.createPlayer");
        Map<String, CodeCoverage> byId = new HashMap<>();
        a.coverage().forEach(c -> byId.put(c.segmentId(), c));
        assertEquals("direct", byId.get(update.id()).status());
        assertEquals(List.of("e1"), byId.get(update.id()).existingTests(), "old tests running through the change");
        assertEquals("indirect", byId.get(validate.id()).status());
        assertEquals(List.of("e1"), byId.get(validate.id()).existingTests());
        assertEquals("existing", byId.get(create.id()).status());
        // none, indirect, existing, direct
        assertEquals(List.of("none", "indirect", "existing", "direct"),
                a.coverage().stream().map(CodeCoverage::status).distinct().toList());
    }

    @Test
    void withoutSelectionNothingChanges() throws Exception {
        Snapshot snapshot = snapshot(added(SERVICE_PATH, SERVICE));
        Analysis a = new Analyzer(defaultRules()).analyze(snapshot, Map.of(SERVICE_PATH, SERVICE));
        assertTrue(a.existingTests().isEmpty());
        assertNull(a.relatedTests());
        assertTrue(a.coverage().stream().allMatch(c -> c.status().equals("none") && c.existingTests().isEmpty()));
    }

    private static Analysis analyse(boolean withChangedTest) throws Exception {
        List<DiffFile> files = withChangedTest
                ? List.of(added(SERVICE_PATH, SERVICE), added(NEW_SPEC_PATH, CHANGED_SPEC))
                : List.of(added(SERVICE_PATH, SERVICE));
        Map<String, String> sources = withChangedTest
                ? Map.of(SERVICE_PATH, SERVICE, NEW_SPEC_PATH, CHANGED_SPEC) : Map.of(SERVICE_PATH, SERVICE);
        Rules rules = defaultRules();
        // the changed test is part of the PR (never selected), the existing one only in the repository
        RelatedTests.Selection selection = RelatedTests.select(rules, files, withChangedTest
                ? List.of(SERVICE_PATH, SPEC_PATH, NEW_SPEC_PATH) : List.of(SERVICE_PATH, SPEC_PATH));
        assertEquals(List.of(SPEC_PATH), selection.files().stream().map(RelatedTestFile::path).toList());
        var related = new dev.codereviewlens.model.Model.RelatedTests(rules.relatedTests.limit(), selection.candidates(),
                selection.truncated(), false, selection.files().stream()
                .map(f -> new RelatedTestFile(f.path(), f.reason(), f.sources(), true)).toList());
        return new Analyzer(rules).analyze(snapshot(files.toArray(DiffFile[]::new)), sources, null, Map.of(), related,
                Map.of(SPEC_PATH, EXISTING_SPEC));
    }

    private static Segment segment(Analysis analysis, String symbol) {
        Segment s = analysis.segments().stream().filter(x -> symbol.equals(x.symbol())).findFirst().orElse(null);
        assertNotNull(s, "segment " + symbol);
        return s;
    }

    private static Snapshot snapshot(DiffFile... files) {
        return new Snapshot(1, "now", new PullRequestInfo("github", "o", "r", 1, "t", "", "me", "", false, "open", "main",
                "feature", "base", "head", "", "", 0, 0, 0, null), List.of(files));
    }

    private static DiffFile changed(String path) {
        return new DiffFile(path, null, "modified", 1, 0, Languages.of(path), false,
                PatchParser.parse("@@ -1,0 +1,1 @@\n+x\n"));
    }

    private static DiffFile added(String path, String content) {
        String[] lines = content.split("\n", -1);
        int n = content.endsWith("\n") ? lines.length - 1 : lines.length;
        StringBuilder patch = new StringBuilder("@@ -0,0 +1," + n + " @@\n");
        for (int i = 0; i < n; i++) {
            patch.append('+').append(lines[i]).append('\n');
        }
        return new DiffFile(path, null, "added", n, 0, Languages.of(path), false, PatchParser.parse(patch.toString()));
    }

    private static String rulesJson() throws Exception {
        try (InputStream in = RelatedTestsTest.class.getResourceAsStream("/rules/default-rules.json")) {
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static Rules defaultRules() throws Exception {
        return Rules.parse(new ObjectMapper().readTree(rulesJson()), "test");
    }
}
